from functools import lru_cache
from typing import BinaryIO

import boto3
from botocore.client import Config
from botocore.exceptions import BotoCoreError, ClientError

from .config import get_settings


class StorageError(RuntimeError):
    """对象存储不可用或操作失败，消息可直接展示给用户。"""


class ObjectStorage:
    def __init__(self, *, endpoint_url: str, access_key: str, secret_key: str, bucket: str, region: str) -> None:
        self.bucket = bucket
        self._client = boto3.client(
            "s3",
            endpoint_url=endpoint_url,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=region,
            config=Config(s3={"addressing_style": "path"}, retries={"max_attempts": 2}, connect_timeout=5),
        )
        self._bucket_ready = False

    def _ensure_bucket(self) -> None:
        if self._bucket_ready:
            return
        try:
            try:
                self._client.head_bucket(Bucket=self.bucket)
            except ClientError as exc:
                if exc.response.get("Error", {}).get("Code") not in {"404", "NoSuchBucket", "NotFound"}:
                    raise
                self._client.create_bucket(Bucket=self.bucket)
        except (ClientError, BotoCoreError) as exc:
            raise StorageError("对象存储不可用，请检查存储服务和访问密钥") from exc
        self._bucket_ready = True

    def put(self, key: str, body: BinaryIO, content_type: str) -> None:
        self._ensure_bucket()
        try:
            self._client.upload_fileobj(body, self.bucket, key, ExtraArgs={"ContentType": content_type})
        except (ClientError, BotoCoreError) as exc:
            raise StorageError("文件写入对象存储失败") from exc

    def get(self, key: str) -> bytes:
        self._ensure_bucket()
        try:
            return self._client.get_object(Bucket=self.bucket, Key=key)["Body"].read()
        except (ClientError, BotoCoreError) as exc:
            raise StorageError("从对象存储读取文件失败") from exc

    def delete(self, key: str) -> None:
        self._ensure_bucket()
        try:
            self._client.delete_object(Bucket=self.bucket, Key=key)
        except (ClientError, BotoCoreError) as exc:
            raise StorageError("从对象存储删除文件失败") from exc

    def delete_prefix(self, prefix: str) -> None:
        self._ensure_bucket()
        try:
            paginator = self._client.get_paginator("list_objects_v2")
            for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
                keys = [{"Key": item["Key"]} for item in page.get("Contents", [])]
                if keys:
                    self._client.delete_objects(Bucket=self.bucket, Delete={"Objects": keys})
        except (ClientError, BotoCoreError) as exc:
            raise StorageError("从对象存储删除文件失败") from exc


@lru_cache
def get_storage() -> ObjectStorage:
    settings = get_settings()
    return ObjectStorage(
        endpoint_url=settings.s3_endpoint_url,
        access_key=settings.s3_access_key,
        secret_key=settings.s3_secret_key,
        bucket=settings.s3_bucket,
        region=settings.s3_region,
    )


def document_storage_key(knowledge_base_id: str, document_id: str, extension: str) -> str:
    return f"knowledge-bases/{knowledge_base_id}/documents/{document_id}/original.{extension}"
