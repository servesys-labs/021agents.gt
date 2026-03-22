"""RAG router — ingest documents, check status, list docs."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form

from agentos.api.deps import CurrentUser, get_current_user

router = APIRouter(prefix="/rag", tags=["rag"])


@router.post("/{agent_name}/ingest")
async def ingest_documents(
    agent_name: str,
    files: list[UploadFile] = File(...),
    chunk_size: int = Form(512),
    user: CurrentUser = Depends(get_current_user),
):
    """Upload and ingest documents into the RAG knowledge base."""
    from agentos.rag.pipeline import RAGPipeline

    documents = []
    metadatas = []
    for f in files:
        content = await f.read()
        text = content.decode(errors="replace")
        if text.strip():
            documents.append(text)
            metadatas.append({"source": f.filename, "filename": f.filename, "agent": agent_name})

    if not documents:
        raise HTTPException(status_code=400, detail="No valid documents to ingest")

    pipeline = RAGPipeline(chunk_size=chunk_size)
    pipeline.ingest(documents, metadatas)

    data_dir = Path.cwd() / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    pipeline.save_chunks(data_dir / "rag_chunks.db")

    index_path = data_dir / "rag_index.json"
    index_data = {
        "agent": agent_name,
        "chunk_size": chunk_size,
        "documents": [{"length": len(d), "metadata": m} for d, m in zip(documents, metadatas)],
        "total_chunks": len(pipeline.retriever._chunks) if hasattr(pipeline.retriever, "_chunks") else 0,
        "source_files": [m.get("source", "") for m in metadatas],
    }
    index_path.write_text(json.dumps(index_data, indent=2) + "\n")

    total_chunks = sum(len(pipeline.chunker.chunk(d)) for d in documents)
    return {
        "documents": len(documents),
        "chunks": total_chunks,
        "sources": [m["filename"] for m in metadatas],
    }


@router.get("/{agent_name}/status")
async def rag_status(agent_name: str):
    """Get RAG index status for an agent."""
    index_path = Path.cwd() / "data" / "rag_index.json"
    chunks_db = Path.cwd() / "data" / "rag_chunks.db"

    if not index_path.exists():
        return {"indexed": False, "documents": 0, "chunks": 0}

    try:
        data = json.loads(index_path.read_text())
        return {
            "indexed": True,
            "agent": data.get("agent", ""),
            "documents": len(data.get("documents", [])),
            "chunks": data.get("total_chunks", 0),
            "chunk_size": data.get("chunk_size", 512),
            "sources": data.get("source_files", []),
            "db_exists": chunks_db.exists(),
        }
    except Exception:
        return {"indexed": False, "documents": 0, "chunks": 0}


@router.get("/{agent_name}/documents")
async def list_documents(agent_name: str):
    """List all ingested documents."""
    index_path = Path.cwd() / "data" / "rag_index.json"
    if not index_path.exists():
        return {"documents": []}
    try:
        data = json.loads(index_path.read_text())
        return {"documents": data.get("documents", [])}
    except Exception:
        return {"documents": []}
