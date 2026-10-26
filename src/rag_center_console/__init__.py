def main() -> None:
    import uvicorn

    uvicorn.run("rag_center_console.main:app", host="0.0.0.0", port=8000, reload=False)
