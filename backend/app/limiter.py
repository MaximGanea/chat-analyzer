from fastapi import Request
from slowapi import Limiter
from slowapi.util import get_remote_address


def _client_ip(request: Request) -> str:
    # X-Real-IP is set by nginx in production; fall back to direct connection for dev
    return request.headers.get("x-Real-IP") or get_remote_address(request)


limiter = Limiter(key_func=_client_ip)
