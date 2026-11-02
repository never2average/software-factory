#!/usr/bin/env python3
"""Verify a ledger bundle in Python (mold_v0-195), independently of the Node code that wrote it.

    python3 scripts/operator/verify_ledger.py <bundle.json> [--public-key <hex|base64>]... [--keys <ledger-keys.json>] [--json]

The bundle is `npm run operator:verify-ledger -- --export <file>` (the rows' values as text, their hashes, the signed
checkpoints). Every entry's hash is recomputed from its values (sha256(prev_hash || canonical entry); canonical: each
field as `<bytes>:<text>;`, a null as `~;`) and linked to the one before; every checkpoint's statement is rebuilt and
its Ed25519 signature checked with the PUBLIC key given here (never the bundle's own list unless no key is given, and
then it says so); its Merkle root (RFC 6962) is recomputed from the entries it signed.
Needs `cryptography` (or PyNaCl). Exit 0 verified, 1 not, 2 could not run.
"""
import hashlib, json, sys, base64

def load_verifier():
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        from cryptography.exceptions import InvalidSignature
        def verify(pub, sig, msg):
            try: Ed25519PublicKey.from_public_bytes(pub).verify(sig, msg); return True
            except InvalidSignature: return False
        return verify, "cryptography"
    except ImportError:
        from nacl.signing import VerifyKey
        from nacl.exceptions import BadSignatureError
        def verify(pub, sig, msg):
            try: VerifyKey(pub).verify(msg, sig); return True
            except BadSignatureError: return False
        return verify, "pynacl"

ZERO = bytes(32)
sha = lambda b: hashlib.sha256(b).digest()

def canon(parts):
    return "".join("~;" if p is None else f"{len(p.encode('utf-8'))}:{p};" for p in parts)

def entry_hash(prev, parts):
    return sha(prev + canon(parts).encode("utf-8"))

def merkle(leaves):
    if not leaves: return sha(b"")
    def mth(lo, hi):
        if hi - lo == 1: return sha(b"\x00" + leaves[lo])
        k = 1
        while k * 2 < hi - lo: k *= 2
        return sha(b"\x01" + mth(lo, lo + k) + mth(lo + k, hi))
    return mth(0, len(leaves))

def statement(c):
    return "\n".join(["ledger-checkpoint/v1", f"stream={c['stream']}", f"scope={c['scope']}", f"n={c['n']}", f"from={c['from_seq']}", f"to={c['to_seq']}",
                      f"entries={c['entries']}", f"last={c['last_hash']}", f"root={c['merkle_root']}", f"prev={c['prev_checkpoint']}",
                      f"signed_ms={c['signed_ms']}", f"kid={c['key_id']}"]).encode("utf-8")

def kid(pub): return hashlib.sha256(pub).hexdigest()[:16]

def parse_pub(v):
    v = v.strip()
    try:
        if len(v) == 64: return bytes.fromhex(v)
    except ValueError: pass
    b = base64.b64decode(v.replace("-", "+").replace("_", "/") + "=" * (-len(v) % 4))
    if len(b) != 32: raise ValueError("not a 32-byte Ed25519 public key")
    return b

def verify_stream(s, keys, verify):
    bad = []
    cps = sorted(s["checkpoints"], key=lambda c: c["n"])
    prev = None
    for c in cps:
        st = statement(c)
        if c["n"] != (prev["n"] + 1 if prev else 1): bad.append((c["from_seq"], f"checkpoint {(prev['n'] + 1) if prev else 1} is missing"))
        if bytes.fromhex(c["prev_checkpoint"]) != (sha(statement(prev)) if prev else ZERO): bad.append((c["from_seq"], f"checkpoint {c['n']} does not follow the one before it"))
        if prev and c["from_seq"] != prev["to_seq"] + 1: bad.append((c["from_seq"], f"checkpoint {c['n']} does not start where {prev['n']} ended"))
        if bytes.fromhex(c["checkpoint_hash"]) != sha(st): bad.append((c["from_seq"], f"checkpoint {c['n']} was changed after it was signed"))
        pub = keys.get(c["key_id"])
        if pub is None: bad.append((c["from_seq"], f"checkpoint {c['n']} is signed with key {c['key_id']}, not one given"))
        elif not verify(pub, bytes.fromhex(c["signature"]), st): bad.append((c["from_seq"], f"checkpoint {c['n']}: the signature does not verify"))
        prev = c
    recomputed, prev_stored, last, first = {}, None, None, None
    for e in s["entries"]:
        seq, ph, h = e["seq"], bytes.fromhex(e["prev_hash"]), bytes.fromhex(e["hash"])
        r = entry_hash(ph, e["parts"])
        if first is None:
            first = seq
            if seq == 1 and ph != ZERO: bad.append((1, "entry 1 does not start the chain"))
        else:
            if seq != last + 1: bad.append((last + 1, f"entries from {last + 1} are missing"))
            if ph != prev_stored: bad.append((seq, f"entry {seq} does not continue the chain"))
        if r != h: bad.append((seq, f"entry {seq}'s values do not give its hash: changed after it was written"))
        recomputed[seq] = r; prev_stored = h; last = seq
    for c in cps:
        if first is not None and c["to_seq"] < first: continue   # pruned by retention
        window = [recomputed.get(q) for q in range(c["from_seq"], c["to_seq"] + 1)]
        if c["from_seq"] < (first or 0):
            if recomputed.get(c["to_seq"]) not in (None, bytes.fromhex(c["last_hash"])): bad.append((c["to_seq"], f"entry {c['to_seq']} no longer gives the hash signed in checkpoint {c['n']}"))
            continue
        if any(w is None for w in window): bad.append((c["from_seq"], f"entries signed in checkpoint {c['n']} are missing")); continue
        if merkle(window) != bytes.fromhex(c["merkle_root"]): bad.append((c["from_seq"], f"the entries {c['from_seq']} to {c['to_seq']} no longer give the Merkle root signed in checkpoint {c['n']}"))
        elif window[-1] != bytes.fromhex(c["last_hash"]): bad.append((c["to_seq"], f"entry {c['to_seq']} no longer gives the last hash signed in checkpoint {c['n']}"))
    bad.sort(key=lambda x: x[0])
    return {"scope": s["scope"], "stream": s["stream"], "ok": not bad, "entries": len(s["entries"]), "checkpoints": len(cps),
            "first_bad_seq": bad[0][0] if bad else None, "reason": bad[0][1] if bad else None}

def main(argv):
    args = argv[1:]
    if not args or args[0].startswith("-"): print(__doc__, file=sys.stderr); return 2
    path, rest = args[0], args[1:]
    pubs, as_json, i = [], False, 0
    try:
        while i < len(rest):
            a = rest[i]
            if a == "--json": as_json = True; i += 1; continue
            if a == "--public-key": pubs.append(parse_pub(rest[i + 1])); i += 2; continue
            if a == "--keys":
                doc = json.load(open(rest[i + 1]))
                pubs += [parse_pub(k.get("public_key_hex") or k["public_key"]) for k in doc.get("keys", [])]; i += 2; continue
            print(f"verify_ledger: unknown argument {a}", file=sys.stderr); return 2
        bundle = json.load(open(path))
        verify, lib = load_verifier()
    except Exception as e:
        print(f"verify_ledger: could not run: {e}", file=sys.stderr); return 2
    note = None
    if not pubs:
        pubs = [bytes.fromhex(k["public_key_hex"]) for k in bundle.get("keys", [])]
        note = "no --public-key given: checked with the keys the bundle names (pass the app's published key to trust nothing in the bundle)"
    keys = {kid(p): p for p in pubs}
    reports = [verify_stream(s, keys, verify) for s in bundle.get("streams", [])]
    ok = all(r["ok"] for r in reports)
    if as_json: print(json.dumps({"ok": ok, "library": lib, "keys": sorted(keys), "note": note, "streams": reports}, indent=2))
    else:
        for r in reports: print(f"{'ok ' if r['ok'] else 'BAD'} scope {r['scope']} {r['stream']}: {r['entries']} entries, {r['checkpoints']} checkpoint(s)" + ("" if r["ok"] else f"\n    first bad: {r['first_bad_seq']}: {r['reason']}"))
        if note: print(f"note: {note}")
        print(f"LEDGER {'VERIFIED' if ok else 'NOT VERIFIED'} in Python ({lib})")
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main(sys.argv))
