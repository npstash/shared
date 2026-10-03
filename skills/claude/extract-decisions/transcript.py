"""Read Claude Code transcripts for the extract-decisions skill. Python stdlib only.

  transcript.py list [--all]   transcripts of this repository; without --all, only unprocessed
  transcript.py show ID        one transcript as compact lines
  transcript.py done ID...     mark transcripts as processed
"""
import json
import pathlib
import re
import sys

REPO = pathlib.Path.cwd()
TRANSCRIPTS = pathlib.Path.home() / ".claude" / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(REPO))
PROCESSED = REPO / ".local_assets" / "extract-decisions" / "processed.txt"
SECRET_WORDS = re.compile(r"passphrase|password|secret|token|api.?key|credential", re.I)
PATH_KEYS = ("file_path", "notebook_path", "path")
# IDE context blocks hold no decisions and can show file contents with secrets.
IDE_BLOCK = re.compile(r"<(ide_selection|ide_opened_file)>.*?</\1>", re.S)


def author(model):
    """Make the author name from a model id, e.g. claude-opus-5-5 -> ClaudeCode/Opus-5.5."""
    m = re.fullmatch(r"claude-([a-z]+)-(\d+(?:-\d)?)(?:-\d{8})?", model or "")
    if not m:
        return "ClaudeCode/" + (model or "unknown")
    return f"ClaudeCode/{m[1].capitalize()}-{m[2].replace('-', '.')}"


def records(sid):
    with open(TRANSCRIPTS / f"{sid}.jsonl", encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            if rec.get("isSidechain"):
                continue
            yield rec


def processed():
    return set(PROCESSED.read_text().split()) if PROCESSED.exists() else set()


def cmd_list(show_all):
    done = processed()
    for p in sorted(TRANSCRIPTS.glob("*.jsonl"), key=lambda p: p.stat().st_mtime):
        sid = p.stem
        if sid in done and not show_all:
            continue
        title, dates = "", []
        for rec in records(sid):
            if rec.get("type") == "ai-title":
                title = rec.get("aiTitle", "")
            if rec.get("timestamp") and rec.get("type") in ("user", "assistant"):
                dates.append(rec["timestamp"][:10])
        if dates:
            mark = "done " if sid in done else ""
            print(f"{mark}{sid}\t{dates[0]}..{dates[-1]}\t{title}")


def answers(rec):
    result = rec.get("toolUseResult")
    return (result.get("answers") or {}) if isinstance(result, dict) else {}


def secret_answers(rec):
    """Free-text answers to questions about secrets that look like a secret: one word, 6+ characters."""
    result = rec.get("toolUseResult")
    options = {
        o.get("label")
        for q in (result.get("questions") or [] if isinstance(result, dict) else [])
        for o in q.get("options") or []
    }
    return {
        a
        for q, a in answers(rec).items()
        if SECRET_WORDS.search(q) and a not in options and re.fullmatch(r"\S{6,}", a or "")
    }


def cmd_show(sid):
    # Collect secret answers from all chats: a later chat can quote one.
    secrets = {a for p in TRANSCRIPTS.glob("*.jsonl") for rec in records(p.stem) for a in secret_answers(rec)}

    def out(text):
        for value in secrets:
            text = text.replace(value, "[secret removed]")
        print(text)

    for rec in records(sid):
        kind, msg = rec.get("type"), rec.get("message")
        if kind not in ("user", "assistant") or not isinstance(msg, dict):
            continue
        date = rec["timestamp"][:10]
        who = "USER" if kind == "user" else author(msg.get("model"))
        content = msg.get("content")
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        for block in content or []:
            t = block.get("type")
            text = IDE_BLOCK.sub("", block.get("text", "")).strip() if t == "text" else ""
            if text:
                out(f"{date} {who}: {text}")
            elif t == "tool_use":
                inp = block.get("input", {})
                paths = [str(inp[k]) for k in PATH_KEYS if k in inp]
                if paths:
                    out(f"{date} {who} [{block['name']}] {' '.join(paths)}")
        for q, a in answers(rec).items():
            out(f"{date} USER answered: {q} -> {a}")


def cmd_done(sids):
    PROCESSED.parent.mkdir(parents=True, exist_ok=True)
    done = processed() | set(sids)
    PROCESSED.write_text("".join(f"{s}\n" for s in sorted(done)))


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["list"]:
        cmd_list("--all" in args)
    elif args[:1] == ["show"] and len(args) == 2:
        cmd_show(args[1])
    elif args[:1] == ["done"] and len(args) > 1:
        cmd_done(args[1:])
    else:
        sys.exit(__doc__)
