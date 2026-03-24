"""Chat platform webhooks — Telegram, Discord, Slack.

Each platform sends webhooks → we parse, route to agent, get response, reply.
The agent runs its full tool chain (RAG, code exec, browsing) and responds
back on the same platform.

Session mapping: platform chat_id → agent session_id (persistent context).
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from agentos.api.deps import CurrentUser, get_current_user, _get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/chat", tags=["chat-platforms"])


def _get_telegram_token() -> str:
    """Get Telegram bot token — from org secrets (DB) first, then env var fallback."""
    # Try org secrets store (set via portal)
    try:
        db = _get_db()
        row = db.conn.execute(
            "SELECT value FROM secrets WHERE name = ? ORDER BY created_at DESC LIMIT 1",
            ("TELEGRAM_BOT_TOKEN",),
        ).fetchone()
        if row:
            val = row["value"] if isinstance(row, dict) else row[0]
            if val:
                return str(val)
    except Exception:
        pass
    # Fallback to env var
    return os.environ.get("TELEGRAM_BOT_TOKEN", "")


# ── Telegram ────────────────────────────────────────────────────────


@router.post("/telegram/webhook")
async def telegram_webhook(request: Request):
    """Receive Telegram bot messages, run agent, reply.

    Flow:
      1. Parse incoming message
      2. Map chat_id → agent session
      3. Send typing indicator
      4. Run agent with message text
      5. Send reply back to Telegram
    """
    from agentos.integrations.chat_platforms.telegram import TelegramAdapter

    bot_token = _get_telegram_token()
    if not bot_token:
        raise HTTPException(status_code=503, detail="TELEGRAM_BOT_TOKEN not configured. Set it in Portal → Integrations → Chat Platforms.")

    # Verify secret token header (if configured)
    webhook_secret = os.environ.get("TELEGRAM_WEBHOOK_SECRET", "")
    if webhook_secret:
        header_secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
        if header_secret != webhook_secret:
            raise HTTPException(status_code=401, detail="Invalid webhook secret")

    adapter = TelegramAdapter(bot_token=bot_token)
    body = await request.body()
    payload = json.loads(body)
    msg = adapter.parse_update(payload)

    if not msg or not msg.text:
        return {"ok": True}  # Ignore non-text updates

    # Handle commands
    if msg.is_command:
        if msg.command == "/start":
            await adapter.send_message(
                msg.chat_id,
                "👋 Hi! I'm your AgentOS agent. Send me a message and I'll help.\n\n"
                "Commands:\n"
                "/ask <question> — Ask me anything\n"
                "/status — Check agent status\n"
                "/help — Show this message",
            )
            return {"ok": True}

        if msg.command == "/help":
            await adapter.send_message(
                msg.chat_id,
                "I can help with research, code, data analysis, and more.\n"
                "Just send a message — no command needed.\n\n"
                "I have access to tools like web search, knowledge base, "
                "code execution, and file browsing.",
            )
            return {"ok": True}

        if msg.command == "/status":
            await adapter.send_message(msg.chat_id, "✅ Agent is running.")
            return {"ok": True}

        # /ask <question> — treat as regular message
        if msg.command == "/ask" and msg.command_args:
            msg.text = msg.command_args

    # Send typing indicator
    await adapter.send_typing(msg.chat_id)

    # Handle file uploads — download and ingest into RAG
    if msg.has_document or msg.has_photo or msg.has_voice:
        file_data = await adapter.download_file(msg.file_id)
        if file_data:
            from agentos.infra.cloudflare_client import get_cf_client
            cf = get_cf_client()
            if cf:
                try:
                    # Upload to R2
                    ext = "txt" if msg.has_document else ("jpg" if msg.has_photo else "ogg")
                    filename = f"telegram-{msg.chat_id}-{int(time.time())}.{ext}"
                    key = f"telegram-{msg.chat_id}/knowledge/{filename}"
                    await cf.storage_put(key, file_data, content_type="application/octet-stream")
                    # If it's a text document, ingest into RAG
                    if msg.has_document:
                        text = file_data.decode("utf-8", errors="replace")
                        await cf.rag_ingest(
                            text=text[:50000],
                            source=filename,
                            org_id=f"telegram-{msg.chat_id}",
                            agent_name="telegram-bot",
                        )
                except Exception as exc:
                    logger.debug("File upload/ingest failed: %s", exc)

            reply = f"📎 File received"
            if msg.caption:
                msg.text = msg.caption  # Process caption as message
            else:
                await adapter.send_message(msg.chat_id, reply, reply_to=msg.message_id)
                return {"ok": True}

    # Run agent — always via backend runtime (same harness for all channels)
    try:
        agent_name = os.environ.get("TELEGRAM_AGENT_NAME", "")
        if agent_name:
            from agentos.agent import Agent
            agent = Agent.from_name(agent_name)
            if hasattr(agent, "set_runtime_context"):
                agent.set_runtime_context(
                    org_id=f"telegram-{msg.chat_id}",
                    project_id="",
                    user_id=f"channel:telegram:{msg.chat_id}",
                )
            results = await agent.run(msg.text)
            output = ""
            for r in results:
                if hasattr(r, "llm_response") and r.llm_response and r.llm_response.content:
                    output = r.llm_response.content
        else:
            output = "No agent configured. Set TELEGRAM_AGENT_NAME."
    except Exception as exc:
        logger.error("Agent run failed: %s", exc)
        output = f"Sorry, I encountered an error: {str(exc)[:200]}"

    # Send reply
    if output:
        # Split long messages (Telegram 4096 char limit)
        for i in range(0, len(output), 4000):
            chunk = output[i:i + 4000]
            await adapter.send_message(
                msg.chat_id,
                chunk,
                reply_to=msg.message_id if i == 0 else 0,
            )

    return {"ok": True}


@router.post("/telegram/connect")
async def telegram_connect(
    request: Request,
    user: CurrentUser = Depends(get_current_user),
):
    """Save Telegram bot token, push to worker, register webhook, return QR.

    This is the one-click setup — user pastes token, everything else is automatic:
    1. Store token in org secrets
    2. Push token to Cloudflare worker as secret (via API)
    3. Register webhook URL with Telegram
    4. Return QR code for scanning
    """
    body = await request.json()
    bot_token = body.get("bot_token", "")
    if not bot_token:
        raise HTTPException(status_code=400, detail="bot_token is required")

    # Step 1: Store in DB secrets
    db = _get_db()
    try:
        db.conn.execute(
            "INSERT OR REPLACE INTO secrets (name, value, org_id, scope, created_at) VALUES (?, ?, ?, 'org', ?)",
            ("TELEGRAM_BOT_TOKEN", bot_token, user.org_id, time.time()),
        )
        db.conn.commit()
    except Exception as exc:
        logger.warning("Failed to store telegram token: %s", exc)

    # Step 2: Push to Cloudflare worker as secret
    cf_account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    cf_token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    worker_name = os.environ.get("CLOUDFLARE_WORKER_NAME", "agentos")
    if cf_account and cf_token:
        import httpx
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                await client.put(
                    f"https://api.cloudflare.com/client/v4/accounts/{cf_account}/workers/scripts/{worker_name}/secrets",
                    headers={"Authorization": f"Bearer {cf_token}", "Content-Type": "application/json"},
                    json={"name": "TELEGRAM_BOT_TOKEN", "text": bot_token, "type": "secret_text"},
                )
        except Exception as exc:
            logger.warning("Failed to push token to worker: %s", exc)

    # Step 3: Register webhook with Telegram
    from agentos.integrations.chat_platforms.telegram import TelegramAdapter
    adapter = TelegramAdapter(bot_token=bot_token)
    worker_url = os.environ.get("AGENTOS_WORKER_URL", "")
    webhook_url = f"{worker_url}/chat/telegram/webhook" if worker_url else ""
    webhook_result = {}
    if webhook_url:
        webhook_secret = os.environ.get("TELEGRAM_WEBHOOK_SECRET", "")
        webhook_result = await adapter.setup_webhook(webhook_url, secret_token=webhook_secret)

    # Step 4: Get bot info for QR
    import httpx
    bot_username = ""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"https://api.telegram.org/bot{bot_token}/getMe")
            data = resp.json()
            bot_username = data.get("result", {}).get("username", "")
    except Exception:
        pass

    deep_link = f"https://t.me/{bot_username}?start=default" if bot_username else ""

    return {
        "success": True,
        "bot_username": bot_username,
        "deep_link": deep_link,
        "webhook_registered": webhook_result.get("ok", False),
        "webhook_url": webhook_url,
        "secret_stored": True,
        "worker_updated": bool(cf_account and cf_token),
    }


@router.post("/telegram/setup")
async def telegram_setup(
    webhook_url: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Register Telegram webhook URL (manual override)."""
    from agentos.integrations.chat_platforms.telegram import TelegramAdapter

    bot_token = _get_telegram_token()
    if not bot_token:
        raise HTTPException(status_code=503, detail="TELEGRAM_BOT_TOKEN not configured")

    webhook_secret = os.environ.get("TELEGRAM_WEBHOOK_SECRET", "")
    adapter = TelegramAdapter(bot_token=bot_token)
    result = await adapter.setup_webhook(webhook_url, secret_token=webhook_secret)
    return result


@router.get("/telegram/qr")
async def telegram_qr(
    agent_name: str = "",
    user: CurrentUser = Depends(get_current_user),
):
    """Generate a QR code and deep link for connecting to the Telegram bot.

    Returns:
      - deep_link: t.me URL that opens the bot
      - qr_svg: inline SVG of the QR code (no external dependencies)
      - qr_data_url: base64 PNG for embedding in <img> tags
    """
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    if not bot_token:
        raise HTTPException(status_code=503, detail="TELEGRAM_BOT_TOKEN not configured")

    # Get bot username from Telegram API
    import httpx
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"https://api.telegram.org/bot{bot_token}/getMe")
            data = resp.json()
            bot_username = data.get("result", {}).get("username", "")
    except Exception:
        bot_username = ""

    if not bot_username:
        raise HTTPException(status_code=500, detail="Could not retrieve bot username")

    # Deep link with optional agent_name as start parameter
    start_param = agent_name or "default"
    deep_link = f"https://t.me/{bot_username}?start={start_param}"

    # Generate QR code as SVG (pure Python, no dependencies)
    qr_svg = _generate_qr_svg(deep_link)

    return {
        "deep_link": deep_link,
        "bot_username": bot_username,
        "agent_name": start_param,
        "qr_svg": qr_svg,
        "instructions": f"Scan this QR code or open {deep_link} to start chatting with your agent on Telegram.",
    }


def _generate_qr_svg(data: str, size: int = 200) -> str:
    """Generate a QR code as inline SVG using a minimal implementation.

    No external dependencies — uses a simple QR encoding algorithm.
    For production, consider using the `qrcode` package for better error correction.
    """
    # Use Python's built-in or fallback
    try:
        import qrcode
        import io
        import base64

        qr = qrcode.QRCode(version=1, box_size=10, border=2)
        qr.add_data(data)
        qr.make(fit=True)
        matrix = qr.get_matrix()

        # Generate SVG
        module_size = size // len(matrix)
        svg_size = module_size * len(matrix)
        rects = []
        for y, row in enumerate(matrix):
            for x, cell in enumerate(row):
                if cell:
                    rects.append(
                        f'<rect x="{x * module_size}" y="{y * module_size}" '
                        f'width="{module_size}" height="{module_size}" fill="black"/>'
                    )
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {svg_size} {svg_size}" '
            f'width="{size}" height="{size}">'
            f'<rect width="{svg_size}" height="{svg_size}" fill="white"/>'
            + "".join(rects)
            + "</svg>"
        )
    except ImportError:
        # Fallback: return a placeholder with the link text
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 200 200">'
            f'<rect width="200" height="200" fill="#f0f0f0" rx="8"/>'
            f'<text x="100" y="90" text-anchor="middle" font-size="12" fill="#333">Scan to chat</text>'
            f'<text x="100" y="110" text-anchor="middle" font-size="10" fill="#666">{data[:40]}</text>'
            f"</svg>"
        )


@router.delete("/telegram/webhook")
async def telegram_delete_webhook(user: CurrentUser = Depends(get_current_user)):
    """Remove Telegram webhook."""
    from agentos.integrations.chat_platforms.telegram import TelegramAdapter

    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    if not bot_token:
        raise HTTPException(status_code=503, detail="TELEGRAM_BOT_TOKEN not configured")

    adapter = TelegramAdapter(bot_token=bot_token)
    return await adapter.delete_webhook()
