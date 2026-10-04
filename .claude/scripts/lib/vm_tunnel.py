#!/usr/bin/env python3
"""vm_tunnel: the private administration tunnel for a `target: vm_remote` application (mold_v1-156).

  provision.py <app_id> --tunnel-remote --dry-run      print every local and remote command and every generated file,
                                                        WITHOUT connecting and without changing this machine
  provision.py <app_id> --tunnel-remote [--factory-apply]
                                                        turn it on: WireGuard between this machine and the server, SSH
                                                        admitted on the tunnel only, public port 22 closed
  provision.py <app_id> --tunnel-remote --off [--factory-apply]
                                                        go back to SSH on the public address
  provision.py <app_id> --tunnel-factory                what would be installed and changed on THIS machine; changes nothing
  provision.py <app_id> --tunnel-factory --apply        do exactly that (and nothing else here)

WHAT IT BUILDS
  One WireGuard interface on each machine, on a private /30 (or /31) of their own. Each machine makes its own key in
  /etc/wireguard/<interface>.key (root, mode 600) and that file never leaves it: not to the other machine, not to the
  repo, not to the chat, not to a command line. Only PUBLIC keys travel, and they are what state holds
  (infrastructure.vm_remote.tunnel). The generated .conf files contain no private key at all: wg-quick loads it from
  the key file with a PostUp line.
  On the server, ufw then admits SSH on the tunnel interface only, and the WireGuard UDP port from this machine's
  public address only. sshd is not reconfigured (it keeps listening as before, so one `ufw allow 22/tcp` at the
  provider's out-of-band console re-opens it), and fail2ban is not touched. At DigitalOcean the out-of-band console is
  the Recovery Console; the Droplet Console is itself an SSH login on port 22 and does not work while that is closed.

THE LOCKOUT GUARD (turn_on). In this order, and the self-test holds it to this order:
   1  this machine's side is checked; anything it lacks is installed only with --factory-apply
   2  ARM: the server starts a ten-minute timer that re-opens public SSH by itself (systemd-run; `ufw allow 22/tcp`)
   3  the server brings WireGuard up and ADDS the two tunnel rules. Public SSH is still open.
   4  this machine brings its side up
   5  LOGIN OVER THE TUNNEL. If it does not work, the run stops here: public SSH was never touched.
   6  CLOSE: sent over the tunnel. The server's script itself refuses unless the command arrived over the tunnel and
      the rollback timer is running; only then does it delete the public SSH rule.
   7  CONFIRM: a fresh login over the tunnel. Only this cancels the timer. If it does not get through, the timer
      re-opens public SSH within ten minutes and nobody is locked out.
   8  from this machine: port 22 must not answer on the public address and must answer on the tunnel address
   9  state: tunnel.enabled true, vm_remote.ssh_host = the server's tunnel address. Every later --deploy-remote,
      --qualify-remote, --verify-rls and health step connects there. The lanes and health-public keep using the domain.
  Every step is safe to run again. If the tunnel is ever down: docs/RUNBOOK.md §9, "If the factory cannot reach the server".
"""
import datetime, hashlib, ipaddress, json, os, re, shlex, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path: sys.path.insert(0, HERE)
import vm_remote as V
from vm_remote import Stop

WG_DIR = "/etc/wireguard"
ROLLBACK_SECONDS = 600
WG_KEY = re.compile(r"^[A-Za-z0-9+/]{43}=$")          # 32 bytes, base64: the shape of a WireGuard public key
IFACE = re.compile(r"^[a-z][a-z0-9_-]{1,14}$")
PLACEHOLDER = {"factory_public_key": "FACTORY-PUBLIC-KEY-NOT-MADE-YET", "server_public_key": "SERVER-PUBLIC-KEY-NOT-MADE-YET",
               "factory_public_address": "FACTORY-PUBLIC-ADDRESS-NOT-SEEN-YET"}

def defaults(app_id):
    """The tunnel's names and addresses for an app that has none in state yet. Derived from the app id, so two
    applications on one factory machine get different interfaces and different networks (validate refuses a clash)."""
    h = hashlib.sha256(app_id.encode()).digest()
    net = ipaddress.ip_network(f"192.168.{h[0]}.{h[1] & 0xFC}/30")
    a, b = list(net.hosts())
    return {"enabled": False, "interface": "sfwg" + h[2:5].hex(), "network": str(net), "factory_address": str(a), "server_address": str(b), "listen_port": 51820}

def tunnel(S):
    """State's tunnel object over the defaults. Public values only."""
    T = defaults(S["app_id"]); T.update({k: v for k, v in (S.get("tunnel") or {}).items() if v not in (None, "")})
    return T
def shown(T):
    """T with a readable placeholder for every value this run has not learned yet (a dry run before the keys exist)."""
    return dict(PLACEHOLDER, **T)
def prefix(T): return ipaddress.ip_network(T["network"]).prefixlen
def key_file(T): return f"{WG_DIR}/{T['interface']}.key"
def conf_file(T): return f"{WG_DIR}/{T['interface']}.conf"
def unit(T): return f"wg-quick@{T['interface']}"
def rollback_unit(S): return f"{S['unit']}-ssh-rollback"
def remote_dir(S): return f"{S['install']}/tunnel"

# ---------------------------------------------------------------------------------------------------------
# generated files. None of them contains a private key: the key is loaded from the key file by PostUp.
# ---------------------------------------------------------------------------------------------------------
CONF_HEAD = ("# GENERATED by .claude/scripts/lib/vm_tunnel.py from state/application/@APP@/ (infrastructure.vm_remote.tunnel).\n"
             "# No private key is in this file: wg-quick loads it from the key file below, which never leaves this machine.\n")
def server_conf(S, T):
    return (V.fill(CONF_HEAD, APP=S["app_id"]) + f"""[Interface]
Address = {T['server_address']}/{prefix(T)}
ListenPort = {T['listen_port']}
PostUp = wg set %i private-key {WG_DIR}/%i.key

[Peer]
# the factory machine
PublicKey = {T['factory_public_key']}
AllowedIPs = {T['factory_address']}/32
""")
def factory_conf(S, T):
    return (V.fill(CONF_HEAD, APP=S["app_id"]) + f"""[Interface]
Address = {T['factory_address']}/{prefix(T)}
PostUp = wg set %i private-key {WG_DIR}/%i.key

[Peer]
# {S['app_id']}'s server
PublicKey = {T['server_public_key']}
Endpoint = {S['host']}:{T['listen_port']}
AllowedIPs = {T['server_address']}/32
PersistentKeepalive = 25
""")

def tunnel_sh(S, T, wg_dir=WG_DIR):
    """The server's side, one script with one verb per step. Every verb is safe to run again. (`wg_dir` is /etc/wireguard
    everywhere but the offline self-test, which runs this very script against stand-in commands in a temp directory.)"""
    pub = V.public_ssh_rule(S); t_ssh, t_wg = V.tunnel_rules(S, T)
    return V.fill(r"""#!/bin/bash
@HEAD@# mold_v1-156: the private administration tunnel, the server's side. Run on the TARGET SERVER, as root, by
# provision.py --tunnel-remote. Never on the factory machine.
#   arm      start the timer that re-opens public SSH by itself in @SECS@ seconds unless `confirm` cancels it
#   up       wireguard-tools, this server's own key (made here, never shown, never leaves), the interface up now and
#            at boot, and the two firewall rules ADDED. Public SSH is not touched.
#   hello    read-only: did this command arrive over the tunnel?
#   close    delete the public SSH rule. Refused unless THIS command arrived over the tunnel and the timer is running.
#   confirm  cancel the timer. Refused unless this command arrived over the tunnel.
#   open     put the public SSH rule back (the first step of --off, and what the break-glass command does)
#   down     remove the tunnel's rules and stop the interface. Refused unless public SSH is open.
#   status   read-only
# sshd is not reconfigured and fail2ban is not touched.
set -eu
@GUARD@export LC_ALL=C
IF=@IF@; KEY=@WGDIR@/@IF@.key; CONF=@WGDIR@/@IF@.conf; SRC=@DIR@/@IF@.conf
SRV=@SRV@; FAC=@FAC@; NET=@NET@; UNIT=@ROLLBACK@
PUB_RULE='@PUB@'; TUN_SSH='@TSSH@'; TUN_WG='@TWG@'
has_rule() { ufw show added 2>/dev/null | grep -qxF "$1"; }
# Any rule at all that lets every address reach the SSH port, however it was written.
public_open() { ufw show added 2>/dev/null | grep -qE '^ufw (allow|limit) (@PORT@(/tcp)?|OpenSSH)$'; }
timer_on() { systemctl is-active --quiet "$UNIT.timer"; }
# SF_SSH_CONNECTION is sshd's own SSH_CONNECTION for this login: "<client> <port> <server address> <port>".
via_tunnel() { set -- ${SF_SSH_CONNECTION:-}; [ "${1:-}" = "$FAC" ] && [ "${3:-}" = "$SRV" ]; }
report() {
  if public_open; then echo "PUBLIC_SSH=open"; else echo "PUBLIC_SSH=closed"; fi
  if timer_on; then echo "ROLLBACK=armed"; else echo "ROLLBACK=none"; fi
  if via_tunnel; then echo "VIA_TUNNEL=yes"; else echo "VIA_TUNNEL=no"; fi
}
case "${1:-}" in
  arm)
    systemctl stop "$UNIT.timer" "$UNIT.service" 2>/dev/null || true
    systemctl reset-failed "$UNIT.timer" "$UNIT.service" 2>/dev/null || true
    systemd-run --quiet --unit="$UNIT" --description="@APP@: re-open public SSH unless the tunnel was confirmed" \
      --on-active=@SECS@ --timer-property=AccuracySec=1s /usr/sbin/ufw allow @PORT@/tcp
    timer_on || { echo "the rollback timer did not start, so nothing was changed" >&2; exit 5; }
    echo "ROLLBACK=armed"
    ;;
  up)
    timer_on || { echo "refusing: the rollback timer is not running, and no firewall rule is changed without it" >&2; exit 5; }
    ufw status | grep -q '^Status: active' || { echo "refusing: the firewall is not active on this server; run the deploy first" >&2; exit 4; }
    if ! command -v wg >/dev/null 2>&1; then
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -q
      apt-get install -y -q wireguard-tools
    fi
    others="$(ip -4 -o addr show | awk -v i="$IF" '$2 != i {print $4}')"
    if ! python3 -c 'import ipaddress,sys; n=ipaddress.ip_network(sys.argv[1]); sys.exit(1 if any(ipaddress.ip_interface(a).network.overlaps(n) for a in sys.argv[2:]) else 0)' "$NET" $others; then
      echo "refusing: this server already has an address inside $NET. Choose another tunnel.network in state/application/@APP@/infrastructure.json. Nothing was changed." >&2; exit 4
    fi
    install -d -m 700 @WGDIR@
    if [ ! -s "$KEY" ]; then ( umask 077; wg genkey > "$KEY" ); fi
    chmod 600 "$KEY"
    changed=no
    if ! cmp -s "$SRC" "$CONF"; then install -m 600 "$SRC" "$CONF"; changed=yes; fi
    systemctl enable wg-quick@"$IF" >/dev/null 2>&1
    if [ "$changed" = yes ] || ! systemctl is-active --quiet wg-quick@"$IF"; then systemctl restart wg-quick@"$IF"; fi
    # A WireGuard rule left from an earlier factory address would admit nobody useful: keep exactly one.
    ufw show added 2>/dev/null | grep -E '^ufw allow from [0-9.]+ to any port @WGPORT@ proto udp$' | while read -r _ rest; do
      [ "ufw $rest" = "$TUN_WG" ] || ufw delete $rest >/dev/null
    done
    $TUN_WG >/dev/null
    $TUN_SSH >/dev/null
    has_rule "$TUN_WG" && has_rule "$TUN_SSH" || { echo "the tunnel's firewall rules were not added; public SSH was not touched" >&2; exit 6; }
    echo "SERVER_PUBLIC_KEY=$(wg pubkey < "$KEY")"
    report
    ;;
  hello)
    report
    via_tunnel
    ;;
  close)
    via_tunnel || { echo "refusing: this command did not arrive over the tunnel ($FAC -> $SRV), so public SSH stays open" >&2; exit 7; }
    timer_on || { echo "refusing: the rollback timer is not running, so public SSH stays open" >&2; exit 5; }
    has_rule "$TUN_SSH" || { echo "refusing: the firewall has no rule admitting SSH on $IF, so public SSH stays open" >&2; exit 6; }
    ufw status | grep -q '^Status: active' || { echo "refusing: the firewall is not active" >&2; exit 4; }
    if has_rule "$PUB_RULE"; then ufw delete allow @PORT@/tcp >/dev/null; fi
    report
    if public_open; then echo "another rule still lets every address reach SSH; it was left alone" >&2; exit 8; fi
    ;;
  confirm)
    via_tunnel || { echo "refusing: this command did not arrive over the tunnel, so the rollback stays armed" >&2; exit 7; }
    if public_open; then
      echo "PUBLIC_SSH=open"; echo "the rollback already re-opened public SSH (or it was never closed); nothing was cancelled" >&2; exit 9
    fi
    systemctl stop "$UNIT.timer" 2>/dev/null || true
    echo "ROLLBACK=cancelled"
    report
    ;;
  open)
    ufw allow @PORT@/tcp >/dev/null
    systemctl stop "$UNIT.timer" 2>/dev/null || true
    report
    public_open
    ;;
  down)
    public_open || { echo "refusing: public SSH is not open, so taking the tunnel down would lock everyone out. Run 'open' first." >&2; exit 7; }
    if via_tunnel; then echo "refusing: this command arrived over the tunnel it would take down. Send it over the public address." >&2; exit 7; fi
    ufw show added 2>/dev/null | grep -E '^ufw allow (in on @IF@ to any port @PORT@ proto tcp|from [0-9.]+ to any port @WGPORT@ proto udp)$' | while read -r _ rest; do
      ufw delete $rest >/dev/null
    done
    systemctl disable --now wg-quick@"$IF" >/dev/null 2>&1 || true
    rm -f @WGDIR@/@IF@.conf
    systemctl stop "$UNIT.timer" 2>/dev/null || true
    echo "TUNNEL=off"
    report
    ;;
  status)
    if ip link show "$IF" >/dev/null 2>&1; then echo "WG=up"; else echo "WG=down"; fi
    report
    ;;
  *) echo "usage: tunnel.sh arm|up|hello|close|confirm|open|down|status" >&2; exit 2 ;;
esac
""", HEAD=V.fill(V.HEAD, APP=S["app_id"]), GUARD=V.fill(V.GUARD, APP=S["app_id"]), APP=S["app_id"], IF=T["interface"], WGDIR=wg_dir,
        DIR=remote_dir(S), SRV=T["server_address"], FAC=T["factory_address"], NET=T["network"], ROLLBACK=rollback_unit(S), SECS=ROLLBACK_SECONDS,
        PORT=S["port"], WGPORT=T["listen_port"], PUB=pub, TSSH=t_ssh, TWG=t_wg)

def bundle(S, T):
    """relative path -> (text, mode) for <install>/tunnel on the server."""
    return {"tunnel.sh": (tunnel_sh(S, T), 0o755), f"{T['interface']}.conf": (server_conf(S, T), 0o600)}
def write_bundle(S, T, out_dir):
    os.makedirs(out_dir, mode=0o700, exist_ok=True)
    for rel, (text, mode) in bundle(S, T).items():
        p = os.path.join(out_dir, rel)
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        with os.fdopen(fd, "w") as f: f.write(text)
        os.chmod(p, mode)
    return out_dir

# ---------------------------------------------------------------------------------------------------------
# the commands: one list for the dry run and the real run
# ---------------------------------------------------------------------------------------------------------
def _sudo(): return [] if os.geteuid() == 0 else ["sudo"]
def via(S, T, door):
    """S as seen through one door: "current" (what state says today), "tunnel" or "public"."""
    if door == "current": return S
    S2 = dict(S)
    S2["ssh_host"] = T["server_address"] if door == "tunnel" else ""
    S2["host_shown"] = S2["ssh_host"] or S["host"] or V.NO_HOST
    return S2
def verb(S, name):
    """One verb of the server's script, as root, with sshd's own record of how this login arrived."""
    return f'{S["sudo"]}env {V.GUARD_VAR}={S["app_id"]} SF_SSH_CONNECTION="$SSH_CONNECTION" bash {remote_dir(S)}/tunnel.sh {name}'

def factory_steps(S, T, conf_path="<the generated factory conf>", off=False):
    """What changes on THIS machine, in order. Exactly: one package, one key file, one conf, one unit."""
    su = _sudo(); k = key_file(T)
    if off:
        return [{"id": "f-unit-off", "where": "factory", "title": f"Stop this machine's side and keep it from starting at boot ({unit(T)})", "argv": su + ["systemctl", "disable", "--now", unit(T)]},
                {"id": "f-conf-off", "where": "factory", "title": f"Remove {conf_file(T)} (the key file stays, so turning the tunnel on again keeps the same public key)", "argv": su + ["rm", "-f", conf_file(T)]}]
    return [
        {"id": "f-tools", "where": "factory", "title": "Install the package wireguard-tools (skipped when the `wg` command is already here)", "argv": su + ["apt-get", "install", "-y", "-q", "wireguard-tools"], "timeout": 600},
        {"id": "f-key", "where": "factory", "title": f"Make this machine's own key in {k} (root, mode 600) if it has none. It is never shown and never leaves this machine",
         "argv": su + ["sh", "-c", f"umask 077; mkdir -p {WG_DIR}; [ -s {k} ] || wg genkey > {k}"]},
        {"id": "f-pub", "where": "factory", "title": "Read the PUBLIC half of that key (the only half that travels; it goes into state)", "argv": su + ["sh", "-c", f"wg pubkey < {k}"]},
        {"id": "f-conf", "where": "factory", "title": f"Write {conf_file(T)} (mode 600; it holds no private key)", "argv": su + ["install", "-m", "600", conf_path, conf_file(T)]},
        {"id": "f-unit", "where": "factory", "title": f"Bring the interface {T['interface']} up now and at every boot ({unit(T)})", "argv": su + ["sh", "-c", f"systemctl enable {unit(T)} && systemctl restart {unit(T)}"]},
    ]

def plan_on(S, T, bundle_dir="<tunnel bundle>", conf_path="<the generated factory conf>", shown_=True):
    cur, tun = via(S, T, "current"), via(S, T, "tunnel")
    ssh = lambda S_, cmd: V.ssh_argv(S_, cmd, shown_)
    f = {s["id"]: s for s in factory_steps(S, T, conf_path)}
    return [
        f["f-tools"], f["f-key"], f["f-pub"],
        {"id": "whoami", "where": "server", "door": "current", "title": "Which address does the server see this machine come from? (read-only; it is the only address the WireGuard port will admit)",
         "argv": ssh(cur, 'echo "SF_CLIENT=${SSH_CONNECTION%% *}"'), "timeout": 60},
        {"id": "t-mkdir", "where": "server", "door": "current", "title": "Make the tunnel's directory on the server", "argv": ssh(cur, V.guarded(S, f"install -d -m 700 {remote_dir(S)}")), "timeout": 60},
        {"id": "t-bundle", "where": "server", "door": "current", "title": "Copy the server's script and its WireGuard conf (public keys only)", "argv": V.rsync_argv(cur, bundle_dir, remote_dir(S), shown=shown_), "timeout": 120},
        {"id": "arm", "where": "server", "door": "current", "title": f"ARM THE ROLLBACK: the server will re-open public SSH by itself in {ROLLBACK_SECONDS // 60} minutes unless step `confirm` cancels it",
         "argv": ssh(cur, verb(S, "arm")), "script": "tunnel.sh", "timeout": 120},
        {"id": "up", "where": "server", "door": "current", "title": "Server: wireguard-tools, its own key (made there, never shown), the interface up now and at boot, the two tunnel rules ADDED. Public SSH is not touched",
         "argv": ssh(cur, verb(S, "up")), "timeout": 900},
        f["f-conf"], f["f-unit"],
        {"id": "login", "where": "server", "door": "tunnel", "title": f"LOG IN OVER THE TUNNEL ({T['factory_address']} -> {T['server_address']}). If this fails the run stops and public SSH stays open",
         "argv": ssh(tun, verb(S, "hello")), "timeout": 90},
        {"id": "close", "where": "server", "door": "tunnel", "title": "CLOSE PUBLIC SSH, sent over the tunnel. The server refuses unless this very command arrived over the tunnel and the rollback is armed",
         "argv": ssh(tun, verb(S, "close")), "timeout": 120},
        {"id": "confirm", "where": "server", "door": "tunnel", "title": "CONFIRM with a fresh login over the tunnel; only this cancels the rollback",
         "argv": ssh(tun, verb(S, "confirm")), "timeout": 90},
        {"id": "probe", "where": "factory", "local": "probe", "title": f"From this machine: port {S['port']} must not answer on {S['host'] or V.NO_HOST} and must answer on {T['server_address']}"},
    ]

def plan_off(S, T, shown_=True):
    tun, pub = via(S, T, "tunnel"), via(S, T, "public")
    ssh = lambda S_, cmd: V.ssh_argv(S_, cmd, shown_)
    return [
        {"id": "reach", "where": "server", "door": "tunnel", "title": "Which door is open? Try the tunnel first, then the public address (read-only)", "argv": ssh(tun, verb(S, "status")), "alt": ssh(pub, verb(S, "status")), "timeout": 60},
        {"id": "open", "where": "server", "door": "tunnel", "title": "RE-OPEN PUBLIC SSH first (one firewall rule added; the tunnel is still up)", "argv": ssh(tun, verb(S, "open")), "alt": ssh(pub, verb(S, "open")), "timeout": 120},
        {"id": "public-login", "where": "server", "door": "public", "title": "LOG IN ON THE PUBLIC ADDRESS. If this fails the run stops and the tunnel stays exactly as it is", "argv": ssh(pub, verb(S, "status")), "timeout": 90},
        {"id": "down", "where": "server", "door": "public", "title": "Server, over the public address: remove the tunnel's two firewall rules, stop the interface and keep it from starting at boot", "argv": ssh(pub, verb(S, "down")), "timeout": 120},
        *factory_steps(S, T, off=True),
        {"id": "probe", "where": "factory", "local": "probe", "title": f"From this machine: port {S['port']} must answer on {S['host'] or V.NO_HOST} again"},
    ]

def print_factory(S, T, out=print, off=False):
    """Exactly what the tunnel installs and changes on this machine. Printing it changes nothing."""
    out(f"On THIS machine (the factory), the tunnel for {S['app_id']} " + ("removes:" if off else "installs and changes exactly this, and nothing else:"))
    if not off:
        out(f"  - the package wireguard-tools (the `wg` and `wg-quick` commands), if it is not already installed")
        out(f"  - {key_file(T)}: this machine's own WireGuard key, root only. It is never shown and never leaves this machine")
        out(f"  - {conf_file(T)}: the interface {T['interface']} with the address {T['factory_address']}/{prefix(T)}, and a route for that /30 only")
        out(f"  - the unit {unit(T)}: enabled, so the tunnel comes back after a reboot")
        out("  No firewall rule, no SSH setting and no other file on this machine is touched.")
    for st in factory_steps(S, T, off=off):
        out(f"  [{st['id']}] {st['title']}"); out("      $ " + shlex.join(st["argv"]))
    if not off:
        out(f"  --- {conf_file(T)}")
        for line in factory_conf(S, shown(T)).rstrip("\n").split("\n"): out("      | " + line)

def print_plan(S, T, off=False, out=print):
    Ts = shown(T); steps = plan_off(S, Ts) if off else plan_on(S, Ts)
    out(f"DRY RUN for {S['app_id']}: nothing below was run, nothing was contacted and nothing on this machine was changed.")
    out(f"  server {S['host'] or V.NO_HOST} (public) · tunnel interface {T['interface']} · this machine {T['factory_address']}, the server {T['server_address']} ({T['network']}) · "
        f"WireGuard on UDP {T['listen_port']} · SSH key name {S['key_ref']} ({V.key_shown(S)})")
    if off:
        out("  Turning the tunnel OFF. Order: public SSH is re-opened FIRST, a login on the public address must then succeed, and only after that is the tunnel taken down.")
    else:
        out("  Turning the tunnel ON. The lockout guard: the rollback is armed before any firewall change; the public SSH rule is deleted only after a login")
        out("  over the tunnel has succeeded in this same run, and by a command that itself arrived over the tunnel; the rollback is cancelled only by a second")
        out("  login over the tunnel afterwards. If anything fails before the close step, public SSH is exactly as it was.")
    for k, v in PLACEHOLDER.items():
        if not T.get(k): out(f"  {v}: not known yet, so that name stands in below; the real run reads it" + (" from this machine's key" if k == "factory_public_key" else " from the server"))
    out("")
    print_factory(S, T, out=out, off=off)
    out("")
    for i, st in enumerate(steps, 1):
        out(f"[{i:02d} {st['id']}] ({st['where']}{', over the ' + st['door'] + ' address' if st.get('door') in ('tunnel', 'public') else ''}) {st['title']}")
        if st.get("local") == "probe":
            if off: out(f"    (local) open a TCP connection to {S['host'] or V.NO_HOST}:{S['port']} (must open)")
            else:
                out(f"    (local) open a TCP connection to {S['host'] or V.NO_HOST}:{S['port']} (must NOT open)")
                out(f"    (local) open a TCP connection to {T['server_address']}:{S['port']} (must open)")
        else:
            out("    $ " + V.shown_cmd(S, st["argv"]))
            if st.get("alt"): out("    $ " + V.shown_cmd(S, st["alt"]) + "     (if the tunnel does not answer)")
        out("")
    if not off:
        out("Generated files, copied to " + remote_dir(S) + " on the server:")
        for k, (text, _) in bundle(S, Ts).items():
            out(f"  --- tunnel/{k}")
            for line in text.rstrip("\n").split("\n"): out("      | " + line)
        out("")
        out(f"After the last step: state/application/{S['app_id']}/infrastructure.json gets vm_remote.tunnel (enabled true, the interface, the addresses, the port and the two")
        out(f"PUBLIC keys) and vm_remote.ssh_host = {T['server_address']}. No private key is written anywhere but {key_file(T)} on each machine.")
    else:
        out(f"After the public login: state/application/{S['app_id']}/infrastructure.json gets vm_remote.tunnel.enabled false and loses vm_remote.ssh_host.")
    out(f"{len(steps)} steps. DRY RUN: nothing was run, nothing was contacted and nothing on this machine was changed.")

# ---------------------------------------------------------------------------------------------------------
# this machine's side
# ---------------------------------------------------------------------------------------------------------
def local_runner(step, stdin_text=None):
    return V.real_runner(dict(step, timeout=step.get("timeout", 120)), stdin_text)

def factory_have(T, local, which=shutil.which):
    """What this machine already has, read-only: {"wg", "key", "unit"}."""
    su = _sudo()
    key = local({"id": "f-have-key", "argv": su + ["test", "-s", key_file(T)]}).returncode == 0
    up = local({"id": "f-have-unit", "argv": ["systemctl", "is-active", "--quiet", unit(T)]}).returncode == 0
    return {"wg": bool(which("wg")), "key": key, "unit": up}
def conf_in_place(T, text, local):
    """Is the conf on this machine already exactly `text`? Compared by a root `cmp` against a temp copy; nothing is read out."""
    d = tempfile.mkdtemp(prefix="sf-tunnel-")
    try:
        p = os.path.join(d, "want.conf"); open(p, "w").write(text)
        return local({"id": "f-have-conf", "argv": _sudo() + ["cmp", "-s", p, conf_file(T)]}).returncode == 0
    finally: shutil.rmtree(d, ignore_errors=True)
def overlap(T, local):
    """An address this machine already has inside the tunnel's network (on another interface), or None."""
    r = local({"id": "f-addrs", "argv": ["ip", "-4", "-o", "addr", "show"]})
    net = ipaddress.ip_network(T["network"])
    for line in (r.stdout or "").splitlines():
        f = line.split()
        if len(f) >= 4 and f[1] != T["interface"]:
            try:
                if ipaddress.ip_interface(f[3]).network.overlaps(net): return f"{f[3]} on {f[1]}"
            except ValueError: continue
    return None
def _ok(step, r, what):
    if r.returncode:
        err = [l for l in V.redact((r.stderr or "") + "\n" + (r.stdout or "")).splitlines() if l.strip()]
        raise Stop(f"step {step['id']} stopped (exit {r.returncode}): " + " / ".join(err[-3:])[:500] + f"\n  {what}")
    return r

def factory_key(S, T, local, apply, say, which=shutil.which):
    """Steps f-tools, f-key, f-pub. Returns this machine's PUBLIC key. Installs or creates only with `apply`."""
    f = {s["id"]: s for s in factory_steps(S, T)}; have = factory_have(T, local, which)
    if not (have["wg"] and have["key"]) and not apply:
        lines = []; print_factory(S, T, out=lines.append)
        raise Stop("\n".join(lines) + f"\nThis machine does not have that yet, and nothing here is installed without your say-so. Nothing was contacted and nothing was "
                   f"changed. To go ahead: python3 .claude/scripts/provision.py {S['app_id']} --tunnel-remote --factory-apply")
    if not have["wg"]:
        say(f"[f-tools] {f['f-tools']['title']}"); _ok(f["f-tools"], local(f["f-tools"]), "Nothing else was changed on this machine and the server was not contacted.")
    if not have["key"]:
        say(f"[f-key] {f['f-key']['title']}"); _ok(f["f-key"], local(f["f-key"]), "The server was not contacted.")
    pub = (_ok(f["f-pub"], local(f["f-pub"]), "The server was not contacted.").stdout or "").strip()
    if not WG_KEY.match(pub): raise Stop("this machine's WireGuard public key could not be read. The server was not contacted and nothing there was changed.")
    return pub
def factory_up(S, T, local, apply, say):
    """Steps f-conf and f-unit: the conf (no private key in it) and the unit. Only with `apply`, unless already in place."""
    text = factory_conf(S, T)
    if conf_in_place(T, text, local) and factory_have(T, local)["unit"]: say(f"[f-conf] {conf_file(T)} is already in place and {unit(T)} is running; this machine was not changed"); return False
    if not apply:
        raise Stop(f"The server's side of the tunnel is ready and PUBLIC SSH IS STILL OPEN, exactly as before. This machine's side is not in place ({conf_file(T)}, "
                   f"{unit(T)}), and nothing here is changed without your say-so. Run it again with the flag: "
                   f"python3 .claude/scripts/provision.py {S['app_id']} --tunnel-remote --factory-apply")
    d = tempfile.mkdtemp(prefix="sf-tunnel-")
    try:
        p = os.path.join(d, f"{T['interface']}.conf")
        fd = os.open(p, os.O_WRONLY | os.O_CREAT, 0o600)
        with os.fdopen(fd, "w") as fh: fh.write(text)
        f = {s["id"]: s for s in factory_steps(S, T, conf_path=p)}
        for sid in ("f-conf", "f-unit"):
            say(f"[{sid}] {f[sid]['title']}")
            _ok(f[sid], local(f[sid]), "PUBLIC SSH IS STILL OPEN on the server, exactly as before; the rollback timer there will fire and change nothing.")
    finally: shutil.rmtree(d, ignore_errors=True)
    return True

# ---------------------------------------------------------------------------------------------------------
# the guard
# ---------------------------------------------------------------------------------------------------------
OPEN = "PUBLIC SSH IS STILL OPEN, exactly as before; nobody is locked out."
def turn_on(S, T, *, runner=V.real_runner, local=local_runner, probe=V.port_open, save=None, say=print, factory_apply=False, wait=time.sleep, which=shutil.which):
    """Turn the tunnel on behind the lockout guard (the module docstring lists the order). `save(T, ssh_host)` writes
    state; `runner`, `local` and `probe` are injected so the whole sequence runs offline in the self-test.
    Returns T as recorded. Raises Stop with one plain instruction otherwise, saying whether public SSH is open."""
    T = dict(T); app = S["app_id"]; again = f"It is safe to run again: python3 .claude/scripts/provision.py {app} --tunnel-remote"
    if S.get("ssh_allow_from"):
        raise Stop(f"{app}: vm_remote.ssh_allow_from is set, which is another way of limiting SSH. Delete that line from state/application/{app}/infrastructure.json first; "
                   f"the tunnel replaces it. Nothing was contacted.")
    # 1  this machine: is its side already in place? If not, it is installed only with the flag, and without the flag
    #    the run stops here, before the server is contacted.
    if not factory_apply:
        have = factory_have(T, local, which)
        ready = have["wg"] and have["key"] and have["unit"] and T.get("server_public_key") and conf_in_place(T, factory_conf(S, T), local)
        if not ready:
            lines = []; print_factory(S, T, out=lines.append)
            raise Stop("\n".join(lines) + f"\nThis machine's side is not in place yet, and nothing here is installed or changed without your say-so. Nothing was contacted "
                       f"and nothing was changed. To go ahead: python3 .claude/scripts/provision.py {app} --tunnel-remote --factory-apply")
    T["factory_public_key"] = factory_key(S, T, local, factory_apply, say, which)
    hit = overlap(T, local)
    if hit: raise Stop(f"{app}: this machine already has the address {hit} inside the tunnel's network {T['network']}. Choose another vm_remote.tunnel.network (a private /30) in "
                       f"state/application/{app}/infrastructure.json. Nothing was contacted.")
    def run(steps, sid, what):
        st = steps[sid]; say(f"[{sid}] {st['title']}")
        return _ok(st, runner(st), what)
    # 2  who does the server see? (read-only)
    steps = {s["id"]: s for s in plan_on(S, shown(T), shown_=False)}
    seen = V.parse_kv(run(steps, "whoami", f"The server did not answer, so nothing was changed. {OPEN}").stdout).get("SF_CLIENT", "")
    if seen and seen != T["factory_address"]:
        try: ipaddress.IPv4Address(seen)
        except ValueError: raise Stop(f"{app}: the server sees this machine as {seen!r}, which is not an IPv4 address; the WireGuard rule is written for IPv4. Nothing was changed. {OPEN}")
        T["factory_public_address"] = seen
    if not T.get("factory_public_address"):
        raise Stop(f"{app}: the server could not say which address this machine comes from, so the WireGuard port cannot be limited to it. Nothing was changed. {OPEN}")
    if save: save(dict(T, enabled=bool(S.get("tunnel_on"))), None)        # public values only; `enabled` is not changed yet
    bundle_dir = tempfile.mkdtemp(prefix="sf-tunnel-bundle-")
    try:
        write_bundle(S, shown(T), bundle_dir)
        steps = {s["id"]: s for s in plan_on(S, shown(T), bundle_dir=bundle_dir, shown_=False)}
        for sid in ("t-mkdir", "t-bundle"): run(steps, sid, f"Nothing on the server's firewall was changed. {OPEN} {again}")
        # 3  ARM, before any firewall change
        r = run(steps, "arm", f"The rollback could not be armed, so no firewall rule was changed. {OPEN} {again}")
        if "ROLLBACK=armed" not in (r.stdout or ""): raise Stop(f"the server did not say the rollback is armed, so no firewall rule was changed. {OPEN} {again}")
        # 4  the server's side up; rules ADDED only
        r = run(steps, "up", f"The tunnel's rules may be partly added, and the public SSH rule was not touched. {OPEN} The rollback timer will fire and change nothing. {again}")
        spk = V.parse_kv(r.stdout).get("SERVER_PUBLIC_KEY", "")
        if not WG_KEY.match(spk): raise Stop(f"the server did not report its WireGuard public key. {OPEN} {again}")
        T["server_public_key"] = spk
        if save: save(dict(T, enabled=bool(S.get("tunnel_on"))), None)
    finally: shutil.rmtree(bundle_dir, ignore_errors=True)
    # 5  this machine's side up
    factory_up(S, T, local, factory_apply, say)
    # 6  LOGIN OVER THE TUNNEL. Nothing is closed before this has succeeded.
    steps = {s["id"]: s for s in plan_on(S, T, shown_=False)}
    st = steps["login"]; say(f"[login] {st['title']}"); r = None
    for attempt in range(4):
        r = runner(st)
        if r.returncode == 0 and "VIA_TUNNEL=yes" in (r.stdout or ""): break
        wait(5)
    else:
        last = V.redact(((r.stderr or "").strip().splitlines() or ["no answer"])[-1])[:200]
        raise Stop(f"{app}: the login over the tunnel ({T['factory_address']} -> {T['server_address']}) did not succeed ({last}), so the public SSH rule was NOT removed. {OPEN} "
                   f"The server's rollback timer will fire within ten minutes and change nothing. Usual causes: a firewall in front of this machine or the server that drops UDP "
                   f"{T['listen_port']}, or this machine's public address is not {T['factory_public_address']}. {again}")
    say("    logged in over the tunnel")
    # 7  CLOSE, over the tunnel
    say(f"[close] {steps['close']['title']}"); r = runner(steps["close"])
    if r.returncode or "PUBLIC_SSH=closed" not in (r.stdout or ""):
        last = V.redact(((r.stderr or "").strip().splitlines() or ["no answer"])[-1])[:240]
        raise Stop(f"{app}: the server did not close public SSH ({last}). Assume PUBLIC SSH IS STILL OPEN; if the rule was removed after all, the rollback re-opens it within "
                   f"ten minutes, because it was not cancelled. {again}")
    # 8  CONFIRM, with a fresh login over the tunnel. Only this cancels the rollback.
    say(f"[confirm] {steps['confirm']['title']}"); r = None
    for attempt in range(3):
        r = runner(steps["confirm"])
        if r.returncode == 0 and "ROLLBACK=cancelled" in (r.stdout or ""): break
        if "PUBLIC_SSH=open" in (r.stdout or ""): break
        wait(5)
    if r.returncode or "ROLLBACK=cancelled" not in (r.stdout or ""):
        raise Stop(f"{app}: public SSH was closed, but the confirmation over the tunnel did not get through, so the rollback was NOT cancelled: the server re-opens "
                   f"public SSH by itself within ten minutes. Nobody is locked out and state was not changed (the factory still uses the public address). "
                   f"Wait ten minutes, then: python3 .claude/scripts/provision.py {app} --tunnel-remote")
    # 9  state, then the outside look
    T["enabled"] = True; T["enabled_at"] = V.now()
    if save: save(T, T["server_address"])
    say(f"[probe] {steps['probe']['title']}")
    bad = V.ssh_door_problems(dict(S, tunnel=T, tunnel_on=True), probe)
    if bad:
        raise Stop(f"{app}: the tunnel is on and recorded in state, but the look from outside disagrees: " + "; ".join(bad) +
                   f". Check for a second firewall in front of the server (the provider's own), then: python3 .claude/scripts/provision.py {app} --tunnel-remote")
    say(f"{app}: the tunnel is on. SSH is closed on {S['host']} and open on {T['server_address']}; every later deploy, check and health step goes through the tunnel.")
    return T

def turn_off(S, T, *, runner=V.real_runner, local=local_runner, probe=V.port_open, save=None, say=print, factory_apply=False, wait=time.sleep):
    """Back to SSH on the public address. Public SSH is re-opened FIRST and proven with a login; only then is the tunnel
    taken down. If the public login fails, the tunnel and state are left exactly as they are."""
    T = dict(T); app = S["app_id"]; steps = {s["id"]: s for s in plan_off(S, T, shown_=False)}
    st = steps["reach"]; say(f"[reach] {st['title']}")
    door = None
    for name, argv in (("argv", st["argv"]), ("alt", st["alt"])):
        r = runner(dict(st, argv=argv))
        if r.returncode == 0: door = name; break
    if door is None:
        raise Stop(f"{app}: the server answered on neither the tunnel nor the public address, so nothing was changed. If the tunnel is down and public SSH is closed, "
                   f"use the provider's recovery console: docs/RUNBOOK.md §9, \"If the factory cannot reach the server\".")
    st = steps["open"]; say(f"[open] {st['title']}")
    r = runner(dict(st, argv=st[door]))
    if r.returncode or "PUBLIC_SSH=open" not in (r.stdout or ""):
        raise Stop(f"{app}: the server did not re-open public SSH, so the tunnel was left exactly as it is and state was not changed. Run it again.")
    st = steps["public-login"]; say(f"[public-login] {st['title']}"); r = None
    for attempt in range(3):
        r = runner(st)
        if r.returncode == 0: break
        wait(5)
    if r.returncode:
        raise Stop(f"{app}: the rule for public SSH was added, but a login on the public address {S['host']} did not succeed, so the tunnel was left up and state was "
                   f"not changed (the factory keeps using the tunnel). Look for a second firewall in front of the server, then run it again.")
    T["enabled"] = False; T.pop("enabled_at", None)
    if save: save(T, "")
    say(f"[down] {steps['down']['title']}")
    r = runner(steps["down"])
    if r.returncode:
        say(f"    the server's side of the tunnel was not fully removed ({V.redact(((r.stderr or '').strip().splitlines() or ['no message'])[-1])[:200]}). Public SSH is open and "
            f"state says the tunnel is off, so every command works; run this again to finish the cleanup.")
    if factory_apply:
        for sid in ("f-unit-off", "f-conf-off"):
            say(f"[{sid}] {steps[sid]['title']}"); local(steps[sid])
    else:
        say(f"    this machine's side ({unit(T)}, {conf_file(T)}) was left as it is: nothing here is changed without the flag. To remove it: "
            f"python3 .claude/scripts/provision.py {app} --tunnel-factory --off --apply")
    if not probe(S["host"], S["port"]):
        raise Stop(f"{app}: state says the tunnel is off, but port {S['port']} did not answer on {S['host']} just now. Try: python3 .claude/scripts/provision.py {app} --qualify-remote")
    say(f"{app}: the tunnel is off. SSH is reached on {S['host']} again.")
    return T

# ---------------------------------------------------------------------------------------------------------
# state, and provision.py's entry
# ---------------------------------------------------------------------------------------------------------
STATE_KEYS = ("enabled", "interface", "network", "factory_address", "server_address", "listen_port", "factory_public_key", "server_public_key",
              "factory_public_address", "enabled_at")
def recorded(T): return {k: T[k] for k in STATE_KEYS if T.get(k) not in (None, "")}
def _with(adir, T, ssh_host):
    infra = json.load(open(os.path.join(adir, "infrastructure.json")))
    vr = infra.setdefault("vm_remote", {}); vr["tunnel"] = recorded(T)
    if ssh_host is not None:
        if ssh_host: vr["ssh_host"] = ssh_host
        else: vr.pop("ssh_host", None)
    return json.dumps(infra, indent=2) + "\n"
def _problems(app_id, adir, text):
    """What factory.py validate would say about this application with `text` as its infrastructure.json, judged on a
    throwaway copy: the real file is not touched."""
    d = tempfile.mkdtemp(prefix="sf-tunnel-state-"); trial = os.path.join(d, app_id)
    try:
        os.makedirs(trial)
        for f in os.listdir(adir):
            if f.endswith(".json") and os.path.isfile(os.path.join(adir, f)): shutil.copyfile(os.path.join(adir, f), os.path.join(trial, f))
        with open(os.path.join(trial, "infrastructure.json"), "w") as fh: fh.write(text)
        return V.state_problems(app_id, trial)
    finally: shutil.rmtree(d, ignore_errors=True)
def write_state(app_id, adir, T, ssh_host):
    """Write the tunnel's public values (and, when `ssh_host` is not None, where SSH connects) into state. Validated on
    a copy first and then replaced in one step, so the file is never half-written and never invalid. No private key can
    reach this function: it is given none."""
    text = _with(adir, T, ssh_host); errs = _problems(app_id, adir, text)
    if errs: raise Stop("the tunnel's values did not fit the state rules, so state was not changed:\n  " + "\n  ".join(errs))
    ip = os.path.join(adir, "infrastructure.json"); tmp = ip + ".tunnel.tmp"
    with open(tmp, "w") as f: f.write(text)
    os.replace(tmp, ip)
def preflight(app_id, adir, T):
    """Would the state this run ends with validate? Asked BEFORE anything is changed, with stand-in public values, so
    the run can never close public SSH and then fail to record where SSH now is. Writes nothing."""
    trial = dict(T, enabled=True, enabled_at=V.now())
    for k, v in (("factory_public_key", "A" * 43 + "="), ("server_public_key", "B" * 43 + "="), ("factory_public_address", "192.0.2.1")):
        if not trial.get(k): trial[k] = v
    errs = _problems(app_id, adir, _with(adir, trial, trial["server_address"]))
    if errs: raise Stop("the state this would end with does not validate, so nothing was contacted and nothing was changed:\n  " + "\n  ".join(errs))

def main_for(app_id, a, S, adir, say=print):
    """`--tunnel-remote` and `--tunnel-factory` for one vm_remote application. Returns the exit code."""
    T = tunnel(S); off = "--off" in a; dry = "--dry-run" in a
    if "--tunnel-factory" in a:
        if "--apply" not in a:
            print_factory(S, T, out=say, off=off)
            say(f"Nothing was changed. To do exactly this: python3 .claude/scripts/provision.py {app_id} --tunnel-factory {'--off ' if off else ''}--apply"); return 0
        if off:
            if S["tunnel_on"]: raise Stop(f"{app_id}: state says the tunnel is on, and this machine's side is how the factory reaches the server. Turn it off first: "
                                          f"python3 .claude/scripts/provision.py {app_id} --tunnel-remote --off")
            for st in factory_steps(S, T, off=True): say(f"[{st['id']}] {st['title']}"); local_runner(st)
            return 0
        T["factory_public_key"] = factory_key(S, T, local_runner, True, say)
        write_state(app_id, adir, dict(T, enabled=S["tunnel_on"]), None)
        say(f"this machine's public key is recorded in state (vm_remote.tunnel.factory_public_key); the private half stayed in {key_file(T)}")
        if T.get("server_public_key"): factory_up(S, T, local_runner, True, say)
        else: say(f"{conf_file(T)} is written once the server has made its own key. Next: python3 .claude/scripts/provision.py {app_id} --tunnel-remote --dry-run")
        return 0
    if dry: print_plan(S, T, off=off, out=say); return 0
    # ---- from here on a real server is contacted -------------------------------------------------------
    errs = V.state_problems(app_id, adir)
    if errs: raise Stop("the state does not validate; nothing was contacted:\n  " + "\n  ".join(errs))
    if not S["host"]: raise Stop(f"{app_id}: the server address is not in state yet. Nothing was contacted.")
    if not os.path.isfile(V.key_path(S)): raise Stop(f"{app_id}: there is no SSH key named {S['key_ref']} on this VM ({V.key_shown(S)}). Nothing was contacted.")
    for tool in ("ssh", "rsync"):
        if not shutil.which(tool): raise Stop(f"this VM has no `{tool}` command. Nothing was contacted.")
    save = lambda T_, ssh_host: write_state(app_id, adir, T_, ssh_host)
    if off:
        if not (S.get("tunnel") or {}).get("interface"): raise Stop(f"{app_id}: no tunnel was ever set up for this app, so there is nothing to turn off. Nothing was contacted.")
        turn_off(S, T, save=save, say=say, factory_apply="--factory-apply" in a); return 0
    preflight(app_id, adir, T)
    turn_on(S, T, save=save, say=say, factory_apply="--factory-apply" in a); return 0
