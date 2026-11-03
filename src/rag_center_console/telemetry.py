import contextvars
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from time import perf_counter
from typing import Any

from .adapters import ProbeTarget
from .chunking import estimate_tokens
from .observability import safe_context, safe_output_text


@dataclass(slots=True)
class ModelCallRecord:
    provider_id: str
    provider: str
    model_id: str
    protocol: str
    purpose: str
    definition_id: str | None = None
    input_context: Any = None
    output_content: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    estimated: bool = False
    latency_ms: float = 0.0
    retry_count: int = 0
    status: str = "completed"
    error_message: str | None = None


@dataclass(slots=True)
class CallTrace:
    records: list[ModelCallRecord] = field(default_factory=list)

    def start(self, target: ProbeTarget, purpose: str) -> ModelCallRecord:
        record = ModelCallRecord(
            provider_id=target.provider_id,
            provider=target.preset_id,
            model_id=target.model_id,
            protocol=target.protocol,
            purpose=purpose,
            definition_id=target.definition_id,
        )
        self.records.append(record)
        return record


_current_call: contextvars.ContextVar[ModelCallRecord | None] = contextvars.ContextVar("model_call", default=None)


def note_retry() -> None:
    if call := _current_call.get():
        call.retry_count += 1


def usage_counts(
    usage: dict[str, int | float] | None,
    input_text: str,
    output_text: str = "",
) -> tuple[int, int, int, bool]:
    if usage:
        input_tokens = int(usage.get("input_tokens") or usage.get("prompt_tokens") or 0)
        output_tokens = int(usage.get("output_tokens") or usage.get("completion_tokens") or 0)
        total_tokens = int(usage.get("total_tokens") or input_tokens + output_tokens)
        if not input_tokens and not output_tokens and total_tokens:
            input_tokens = total_tokens
        return input_tokens, output_tokens, total_tokens, False
    input_tokens = estimate_tokens(input_text)
    output_tokens = estimate_tokens(output_text) if output_text else 0
    return input_tokens, output_tokens, input_tokens + output_tokens, True


def finish_call(
    record: ModelCallRecord,
    *,
    started: float,
    usage: dict[str, int | float] | None,
    input_text: str,
    output_text: str = "",
    error: BaseException | None = None,
    input_context: Any = None,
    output_content: str | None = None,
) -> None:
    record.latency_ms = round((perf_counter() - started) * 1000, 3)
    record.input_tokens, record.output_tokens, record.total_tokens, record.estimated = usage_counts(
        usage, input_text, output_text
    )
    record.input_context = safe_context(input_context if input_context is not None else input_text)
    record.output_content = safe_output_text(output_content if output_content is not None else output_text) or None
    if error is not None:
        record.status = "failed"
        record.error_message = str(error)[:500]


async def trace_call(
    trace: CallTrace | None,
    target: ProbeTarget,
    purpose: str,
    operation: Callable[[], Awaitable[Any]],
    *,
    input_text: str,
    output_text: Callable[[Any], str] = lambda _: "",
    input_context: Any = None,
) -> Any:
    if trace is None:
        return await operation()
    record = trace.start(target, purpose)
    token = _current_call.set(record)
    started = perf_counter()
    try:
        result = await operation()
    except Exception as exc:
        finish_call(record, started=started, usage=None, input_text=input_text, error=exc, input_context=input_context)
        raise
    finally:
        _current_call.reset(token)
    finish_call(
        record,
        started=started,
        usage=getattr(result, "usage", None),
        input_text=input_text,
        output_text=output_text(result),
        input_context=input_context,
    )
    return result


def messages_text(messages: list[dict[str, Any]]) -> str:
    return "\n".join(str(message.get("content", "")) for message in messages)
