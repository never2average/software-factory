"""python3 -m finlib.selftest — run every finlib module's built-in cases. Exit 0 = all pass."""
import sys
from . import numbers, units, periods, schema, pdfdoc

def main():
    total = 0
    for m in (numbers, units, periods, schema, pdfdoc):
        try: n = m._self_test(); total += n; print(f"ok   finlib.{m.__name__.split('.')[-1]}  ({n} cases)")
        except AssertionError as x: print(f"FAIL finlib.{m.__name__.split('.')[-1]}: {x}", file=sys.stderr); return 1
    print(f"finlib: {total} cases passed"); return 0

if __name__ == "__main__": sys.exit(main())
