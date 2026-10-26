import hashlib
from dataclasses import dataclass
from pathlib import PurePosixPath, PureWindowsPath
from tempfile import SpooledTemporaryFile
from typing import BinaryIO

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Document


class UploadRejected(ValueError):
    """文件未通过校验，消息可直接展示给用户。"""


_OLE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
_ZIP = b"PK\x03\x04"
_TEXT = "text"

# 扩展名 -> (允许的 MIME, 文件头特征)。浏览器常对未知类型给出 application/octet-stream，因此始终放行。
ALLOWED_TYPES: dict[str, tuple[frozenset[str], bytes | str]] = {
    "doc": (frozenset({"application/msword"}), _OLE),
    "docx": (frozenset({"application/vnd.openxmlformats-officedocument.wordprocessingml.document"}), _ZIP),
    "pdf": (frozenset({"application/pdf"}), b"%PDF"),
    "md": (frozenset({"text/markdown", "text/x-markdown", "text/plain"}), _TEXT),
    "png": (frozenset({"image/png"}), b"\x89PNG\r\n\x1a\n"),
    "jpg": (frozenset({"image/jpeg"}), b"\xff\xd8\xff"),
    "jpeg": (frozenset({"image/jpeg"}), b"\xff\xd8\xff"),
    "webp": (frozenset({"image/webp"}), "webp"),
    "tiff": (frozenset({"image/tiff"}), "tiff"),
    "csv": (frozenset({"text/csv", "text/plain", "application/csv", "application/vnd.ms-excel"}), _TEXT),
    "xls": (frozenset({"application/vnd.ms-excel"}), _OLE),
    "xlsx": (frozenset({"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}), _ZIP),
}
GENERIC_MIME = "application/octet-stream"
EXTENSIONS_LABEL = "、".join(f".{extension}" for extension in ALLOWED_TYPES)


@dataclass
class SpooledUpload:
    file: BinaryIO
    filename: str
    extension: str
    mime_type: str
    size_bytes: int
    sha256: str

    def close(self) -> None:
        self.file.close()


def normalize_filename(filename: str | None) -> str:
    name = PurePosixPath(PureWindowsPath(filename or "").name).name.strip()
    if not name:
        raise UploadRejected("文件名不能为空")
    return name[-255:] if len(name) > 255 else name


def _matches_signature(extension: str, head: bytes) -> bool:
    signature = ALLOWED_TYPES[extension][1]
    if signature == _TEXT:
        return b"\x00" not in head
    if signature == "webp":
        return head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    if signature == "tiff":
        return head[:4] in {b"II*\x00", b"MM\x00*"}
    return head.startswith(signature)


def spool_upload(filename: str | None, content_type: str | None, source: BinaryIO, max_bytes: int) -> SpooledUpload:
    """流式读取上传内容，同时校验扩展名、MIME、文件头和大小，并计算 SHA-256。"""
    name = normalize_filename(filename)
    extension = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if extension not in ALLOWED_TYPES:
        raise UploadRejected(f"不支持的文件格式，仅支持 {EXTENSIONS_LABEL}")
    mime_type = (content_type or GENERIC_MIME).split(";")[0].strip().lower() or GENERIC_MIME
    if mime_type != GENERIC_MIME and mime_type not in ALLOWED_TYPES[extension][0]:
        raise UploadRejected(f"文件类型与扩展名 .{extension} 不匹配")

    digest = hashlib.sha256()
    size = 0
    head = b""
    spool = SpooledTemporaryFile(max_size=8 * 1024 * 1024)
    try:
        while chunk := source.read(1024 * 1024):
            if not head:
                head = chunk[:8192]
            size += len(chunk)
            if size > max_bytes:
                raise UploadRejected(f"文件超过 {max_bytes // (1024 * 1024)} MB 上限")
            digest.update(chunk)
            spool.write(chunk)
        if size == 0:
            raise UploadRejected("文件内容为空")
        if not _matches_signature(extension, head):
            raise UploadRejected(f"文件内容与扩展名 .{extension} 不符，可能已损坏或被改名")
        spool.seek(0)
    except BaseException:
        spool.close()
        raise
    return SpooledUpload(
        file=spool,
        filename=name,
        extension=extension,
        mime_type=mime_type if mime_type != GENERIC_MIME else next(iter(sorted(ALLOWED_TYPES[extension][0]))),
        size_bytes=size,
        sha256=digest.hexdigest(),
    )


def find_duplicate_documents(db: Session, knowledge_base_id: str, sha256: str) -> list[Document]:
    return list(
        db.scalars(
            select(Document)
            .where(Document.knowledge_base_id == knowledge_base_id, Document.sha256 == sha256)
            .order_by(Document.created_at)
        )
    )
