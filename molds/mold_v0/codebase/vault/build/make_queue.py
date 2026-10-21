"""Write curate/queue.txt: pending chunks (input without output), highest-value stacks first. Prints the next N."""
import glob, os, sys
os.chdir(os.path.dirname(os.path.abspath(__file__)))
done = {os.path.basename(p)[:-5] for p in glob.glob("curate/out/*.json")}
names = [os.path.basename(p)[:-6] for p in glob.glob("curate/in/*.jsonl")]
launched = set(open("curate/launched.txt").read().split()) if os.path.exists("curate/launched.txt") else set()
pending = [n for n in names if n not in done and n not in launched]
order = ["agents", "flutter", "react-native", "nextjs-ts", "any", "fastapi", "go-http", "django", "express-ts"]


def key(n):
    for i, o in enumerate(order):
        if f"-{o}-" in f"-{n}-":
            return (i, n)
    return (99, n)


pending.sort(key=key)
open("curate/queue.txt", "w").write("\n".join(pending) + "\n")
print(len(pending), "pending; next:", " ".join(pending[: int(sys.argv[1]) if len(sys.argv) > 1 else 10]))
