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

    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    if not bot_token:
        raise HTTPException(status_code=503, detail="TELEGRAM_BOT_TOKEN not configured")

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
            # Store in knowledge base via worker
            worker_url = os.environ.get("AGENTOS_WORKER_URL", "")
            if worker_url:
                import httpx
                try:
                    async with httpx.AsyncClient(timeout=30) as client:
                        # Upload to R2
                        ext = "txt" if msg.has_document else ("jpg" if msg.has_photo else "ogg")
                        filename = f"telegram-{msg.chat_id}-{int(time.time())}.{ext}"
                        await client.post(
                            f"{worker_url}/storage/upload?org_id=telegram-{msg.chat_id}&category=knowledge&filename={filename}",
                            content=file_data,
                        )
                        # If it's a text document, try to ingest into RAG
                        if msg.has_document:
                            text = file_data.decode("utf-8", errors="replace")
                            await client.post(
                                f"{worker_url}/rag/ingest",
                                json={
                                    "text": text[:50000],
                                    "org_id": f"telegram-{msg.chat_id}",
                                    "agent_name": "telegram-bot",
                                    "source": filename,
                                },
                            )
                except Exception as exc:
                    logger.debug("File upload/ingest failed: %s", exc)

            reply = f"📎 File received"
            if msg.caption:
                msg.text = msg.caption  # Process caption as message
            else:
                await adapter.send_message(msg.chat_id, reply, reply_to=msg.message_id)
                return {"ok": True}

    # Run agent
    try:
        agent_name = os.environ.get("TELEGRAM_AGENT_NAME", "")
        worker_url = os.environ.get("AGENTOS_WORKER_URL", "")

        if worker_url:
            # Route through Cloudflare worker → agent DO
            import httpx
            async with httpx.AsyncClient(timeout=120) as client:
                resp = await client.post(
                    f"{worker_url}/agents/agent-os-agent/telegram-{msg.chat_id}/run",
                    json={"input": msg.text},
                    headers={"Content-Type": "application/json"},
                )
                if resp.status_code == 200:
                    data = resp.json()
                    output = data.get("output", "") or data.get("content", "")
                    if not output and data.get("turnResults"):
                        last = data["turnResults"][-1]
                        output = last.get("content", "")
                else:
                    output = f"Agent error ({resp.status_code})"
        elif agent_name:
            # Run locally via Python agent
            from agentos.agent import Agent
            agent = Agent.from_name(agent_name)
            results = await agent.run(msg.text)
            output = ""
            for r in results:
                if hasattr(r, "llm_response") and r.llm_response and r.llm_response.content:
                    output = r.llm_response.content
        else:
            output = "No agent configured. Set TELEGRAM_AGENT_NAME or AGENTOS_WORKER_URL."
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


@router.post("/telegram/setup")
async def telegram_setup(
    webhook_url: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Register Telegram webhook URL."""
    from agentos.integrations.chat_platforms.telegram import TelegramAdapter

    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
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
