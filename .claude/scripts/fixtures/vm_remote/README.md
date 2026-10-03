# vm_remote fixture

`vm_remote_fixture/` is a complete application state with `target: vm_remote`, kept outside `state/` so it is never a registered
application. The address is from the documentation range (203.0.113.0/24) and the domain is example.com: nothing here names a real server.

    python3 .claude/scripts/factory.py validate --app-dir .claude/scripts/fixtures/vm_remote/vm_remote_fixture
    python3 .claude/scripts/lib/vm_remote.py plan .claude/scripts/fixtures/vm_remote/vm_remote_fixture
    python3 .claude/scripts/lib/vm_remote.py --self-test

`qualify-*.txt` are host-probe answers (the output of the generated `qualify.sh`) the self-test parses; `health-ok.txt` is a
healthy server's answer to `health.sh`.
