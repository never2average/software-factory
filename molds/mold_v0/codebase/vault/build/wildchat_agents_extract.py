"""Agent-building requests from allenai/WildChat-4.8M (ODC-BY): first user turns asking to BUILD an LLM agent/assistant
with tools, retrieval, memory, documents or planning, or naming agent frameworks. Chunked reads; one shard on disk.
  python wildchat_agents_extract.py OUT_DIR SHARD_START SHARD_END
"""
import hashlib, json, os, re, sys
import pyarrow.parquet as pq
from huggingface_hub import hf_hub_download

out_dir, start, end = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
os.makedirs(out_dir, exist_ok=True)
FRAMEWORK = re.compile(r"\b(langchain|llama ?index|autogen|crew ?ai|semantic kernel|langgraph|haystack|function[- ]calling|"
                       r"tool[- ]calling|tool use|retrieval[- ]augmented|\brag\b|assistants? api|auto-?gpt|babyagi|agentic)\b", re.I)
BUILD = re.compile(r"\b(build|create|make|develop|implement|write|code|design|set up|setup)\b", re.I)
AGENTISH = re.compile(r"\b(agents?|assistant|chat ?bot|bot|copilot)\b", re.I)
CAPS = re.compile(r"\b(tools?|function|api calls?|search(es)? the web|web search|retriev\w*|memory|remember|knowledge base|"
                  r"documents?|pdfs?|database|plan(s|ning)?|multi[- ]step|autonomous\w*|workflow|actions?|browse|embeddings?|"
                  r"vector)\b", re.I)
CODE_DUMP = re.compile(r"(```|\n\s*(def |class |import |function |const |public |#include))")
SYSTEMISH = re.compile(r"^\s*(system\s*:|you are\b|act as\b|i want you to act|pretend|from now on|imagine you)", re.I)
BUILD_AGENT = re.compile(r"\b(build|create|make|develop|implement|write|code|design|set up)\b[^.?!\n]{0,80}\b(agents?|assistant|chat ?bot|bot|copilot)\b", re.I)
JAIL = re.compile(r"\b(jailbreak|DAN\b|ignore (all|previous) instructions|you are (now )?(an? )?(unfiltered|immoral))", re.I)

out = open(os.path.join(out_dir, "candidates.jsonl"), "a")
for i in range(start, end):
    path = hf_hub_download("allenai/WildChat-4.8M", f"data/train-{i:05d}-of-00086.parquet", repo_type="dataset",
                           cache_dir=os.path.join(out_dir, "shards"))
    kept = 0
    for b in pq.ParquetFile(path).iter_batches(batch_size=2000, columns=["conversation_hash", "language", "conversation", "toxic"]):
        for row in b.to_pylist():
            if row["language"] != "English" or row["toxic"]:
                continue
            first = next((m for m in (row["conversation"] or []) if m.get("role") == "user"), None)
            text = (first or {}).get("content", "").strip()
            words = len(text.split())
            if words < 15 or words > 400 or CODE_DUMP.search(text) or JAIL.search(text) or SYSTEMISH.search(text):
                continue
            if not ((FRAMEWORK.search(text) and BUILD.search(text)) or (BUILD_AGENT.search(text) and CAPS.search(text))):
                continue
            h = hashlib.sha1(re.sub(r"\W+", " ", text.lower()).strip().encode()).hexdigest()
            out.write(json.dumps({"hash": h, "source": "allenai/WildChat-4.8M", "source_id": row["conversation_hash"],
                                  "license": "ODC-BY-1.0", "stacks": ["any"], "categories": ["agents"], "text": text}) + "\n")
            kept += 1
    out.flush()
    os.remove(os.path.realpath(path))
    print(f"shard {i}: {kept} agent candidates", flush=True)
