#!/usr/bin/env nix-shell
#!nix-shell -i python3 -p "python3.withPackages(ps: [ps.pymysql])"
"""Import a Signal Android plaintext export (backup-v2 JSONL) into the signal
archive MariaDB, deduped against the live feed.

The export (Signal Android beta: "export" → Documents/signal-export-*/main.jsonl)
is a stream of JSON frames: account / recipient / chat / chatItem / stickerPack.
This resolves the internal recipient/chat ids and writes messages, contacts,
conversations, reactions and attachment metadata into the same tables the live
ingester uses. Dedupe is on (sender_uuid, server_ts), so it is safe to run
alongside the live feed and to re-run.

Attachment BYTES are not imported (they live in the export's files/ tree keyed by
hash); metadata only, matching the live v1 behaviour.

Usage (env: DB_HOST DB_PORT DB_USER DB_PASSWORD DB_NAME, SELF_UUID):
    ./import_jsonl.py main.jsonl [--dry-run] [--limit N]
"""
import base64
import json
import os
import sys
import uuid

import pymysql


def b64_to_uuid(b64):
    try:
        raw = base64.b64decode(b64)
        if len(raw) != 16:
            return None
        return str(uuid.UUID(bytes=raw))
    except Exception:
        return None


def norm_phone(e164):
    if not e164:
        return None
    return e164 if e164.startswith("+") else "+" + e164


def contact_name(c):
    for a, b in (("systemGivenName", "systemFamilyName"),
                 ("profileGivenName", "profileFamilyName")):
        nm = " ".join(x for x in (c.get(a), c.get(b)) if x).strip()
        if nm:
            return nm
    nick = c.get("nickname") or {}
    nm = " ".join(x for x in (nick.get("given"), nick.get("family")) if x).strip()
    return nm or None


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    opts = [a for a in sys.argv[1:] if a.startswith("--")]
    path = args[0]
    dry = "--dry-run" in opts
    limit = next((int(o.split("=")[1]) for o in opts if o.startswith("--limit=")), None)
    self_uuid = os.environ["SELF_UUID"]

    # --- pass 1: build recipient + chat maps -------------------------------
    recipients = {}   # id -> dict(uuid, phone, name, is_group, group_key, group_name, is_self)
    chats = {}        # chatId -> recipientId
    with open(path) as f:
        for line in f:
            try:
                frame = json.loads(line)
            except Exception:
                continue
            if "recipient" in frame:
                r = frame["recipient"]
                rid = r["id"]
                if "self" in r:
                    recipients[rid] = {"uuid": self_uuid, "phone": "+447880472093",
                                       "name": "Me", "is_group": False, "is_self": True}
                elif "contact" in r:
                    c = r["contact"]
                    recipients[rid] = {
                        "uuid": b64_to_uuid(c.get("aci")), "phone": norm_phone(c.get("e164")),
                        "name": contact_name(c), "is_group": False, "is_self": False}
                elif "group" in r:
                    g = r["group"]
                    title = (((g.get("snapshot") or {}).get("title") or {}).get("title"))
                    recipients[rid] = {"uuid": None, "phone": None, "name": title,
                                       "is_group": True, "group_key": g.get("masterKey"),
                                       "group_name": title, "is_self": False}
                else:  # releaseNotes / distributionList / callLink etc.
                    recipients[rid] = {"uuid": None, "phone": None, "name": None,
                                       "is_group": False, "is_self": False}
            elif "chat" in frame:
                chats[frame["chat"]["id"]] = frame["chat"]["recipientId"]

    def sender_of(author_id):
        r = recipients.get(author_id)
        if not r:
            return None
        return r["uuid"] or r["phone"]

    def thread_of(chat_id):
        rid = chats.get(chat_id)
        r = recipients.get(rid) if rid else None
        if not r:
            return (f"chat:{chat_id}", "dm")
        if r["is_group"]:
            return (f"group:{r.get('group_key')}", "group")
        return (f"dm:{r['uuid'] or r['phone']}", "dm")

    # --- connect -----------------------------------------------------------
    conn = pymysql.connect(
        host=os.environ["DB_HOST"], port=int(os.environ.get("DB_PORT", "3306")),
        user=os.environ["DB_USER"], password=os.environ["DB_PASSWORD"],
        database=os.environ["DB_NAME"], charset="utf8mb4", autocommit=False)
    cur = conn.cursor()

    def upsert_contact(u):
        if dry or not u or not (u.get("uuid")):
            return
        cur.execute(
            "INSERT INTO contacts (uuid, phone, profile_name) VALUES (%s,%s,%s) "
            "ON DUPLICATE KEY UPDATE phone=COALESCE(VALUES(phone),phone), "
            "profile_name=COALESCE(VALUES(profile_name),profile_name)",
            (u["uuid"], u.get("phone"), u.get("name")))

    # seed all contacts up front
    for r in recipients.values():
        upsert_contact(r)

    seen_threads = set()
    stats = {"messages": 0, "dups": 0, "reactions": 0, "attachments": 0,
             "skipped": 0, "errors": 0}

    def ensure_thread(thread_id, kind, name):
        if dry or thread_id in seen_threads:
            return
        seen_threads.add(thread_id)
        cur.execute("INSERT INTO conversations (thread_id, type, name) VALUES (%s,%s,%s) "
                    "ON DUPLICATE KEY UPDATE name=COALESCE(VALUES(name),name)",
                    (thread_id, kind, name))

    with open(path) as f:
        n = 0
        for line in f:
            if limit and stats["messages"] >= limit:
                break
            try:
                frame = json.loads(line)
            except Exception:
                continue
            item = frame.get("chatItem")
            if not item:
                continue
            try:
                sender = sender_of(item["authorId"])
                ts = int(item["dateSent"])
                if not sender or not ts:
                    stats["skipped"] += 1
                    continue
                thread_id, kind = thread_of(item["chatId"])
                rid = chats.get(item["chatId"])
                tname = recipients.get(rid, {}).get("name") if rid else None
                is_out = "outgoing" in item

                std = item.get("standardMessage")
                body = None
                if std:
                    body = (std.get("text") or {}).get("body")
                elif "stickerMessage" in item:
                    body = "[sticker]"
                elif "remoteDeletedMessage" in item:
                    body = "[deleted message]"
                elif "viewOnceMessage" in item:
                    body = "[view-once media]"
                else:
                    stats["skipped"] += 1   # group updates / system frames
                    continue

                quote = None
                if std and std.get("quote"):
                    qt = std["quote"].get("targetSentTimestamp")
                    quote = int(qt) if qt else None

                ensure_thread(thread_id, kind, tname)

                if dry:
                    stats["messages"] += 1
                else:
                    cur.execute(
                        "INSERT IGNORE INTO messages "
                        "(thread_id, sender_uuid, server_ts, body, quote_target_ts, is_outgoing) "
                        "VALUES (%s,%s,%s,%s,%s,%s)",
                        (thread_id, sender, ts, body, quote, 1 if is_out else 0))
                    if cur.rowcount == 0:
                        stats["dups"] += 1
                        continue
                    stats["messages"] += 1
                    mid = cur.lastrowid
                    for att in (std.get("attachments") if std else []) or []:
                        p = att.get("pointer") or {}
                        cur.execute(
                            "INSERT INTO attachments (message_id, content_type, file_name, size_bytes) "
                            "VALUES (%s,%s,%s,%s)",
                            (mid, p.get("contentType"), p.get("fileName"),
                             int(p["size"]) if p.get("size") else None))
                        stats["attachments"] += 1

                for rx in (std.get("reactions") if std else []) or []:
                    rauth = sender_of(rx.get("authorId"))
                    if not rauth:
                        continue
                    stats["reactions"] += 1
                    if not dry:
                        cur.execute(
                            "INSERT IGNORE INTO reactions "
                            "(thread_id, target_ts, author_uuid, emoji, reaction_ts, removed) "
                            "VALUES (%s,%s,%s,%s,%s,0)",
                            (thread_id, ts, rauth, rx.get("emoji"),
                             int(rx.get("sentTimestamp") or ts)))
                n += 1
                if not dry and n % 2000 == 0:
                    conn.commit()
                    print(f"  ... {stats['messages']} inserted, {stats['dups']} dup", flush=True)
            except Exception as e:
                stats["errors"] += 1
                if stats["errors"] <= 5:
                    print(f"  error on a frame: {e}", file=sys.stderr)

    if not dry:
        conn.commit()
    conn.close()
    print(f"{'DRY-RUN ' if dry else ''}done: {stats}")


if __name__ == "__main__":
    main()
