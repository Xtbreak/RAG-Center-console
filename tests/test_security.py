from cryptography.fernet import Fernet

from rag_center_console.security import SecretBox, mask_api_key


def test_secret_box_round_trip_and_ciphertext_does_not_expose_key():
    box = SecretBox(Fernet.generate_key().decode("ascii"))
    secret = "sk-sensitive-value"
    encrypted = box.encrypt(secret)

    assert secret not in encrypted
    assert box.decrypt(encrypted) == secret
    assert mask_api_key("alue") == "••••••••alue"
