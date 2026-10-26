from cryptography.fernet import Fernet, InvalidToken

from .config import get_settings


class SecretConfigurationError(RuntimeError):
    pass


class SecretBox:
    def __init__(self, key: str) -> None:
        if not key:
            raise SecretConfigurationError("RAG_ENCRYPTION_KEY 未配置")
        try:
            self._fernet = Fernet(key.encode("ascii"))
        except (ValueError, UnicodeEncodeError) as exc:
            raise SecretConfigurationError("RAG_ENCRYPTION_KEY 必须是有效的 Fernet 密钥") from exc

    def encrypt(self, value: str) -> str:
        return self._fernet.encrypt(value.encode("utf-8")).decode("ascii")

    def decrypt(self, value: str) -> str:
        try:
            return self._fernet.decrypt(value.encode("ascii")).decode("utf-8")
        except InvalidToken as exc:
            raise SecretConfigurationError("无法使用当前主密钥解密供应商密钥") from exc


def get_secret_box() -> SecretBox:
    return SecretBox(get_settings().encryption_key)


def mask_api_key(last4: str) -> str:
    return f"••••••••{last4}"
