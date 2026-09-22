"""Typed I/O signal descriptors used by simulation components and PLC mapping."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Optional


@dataclass(frozen=True)
class Signal:
    """A PLC-facing signal exposed by a simulated component.

    direction is ``PLC -> OMS`` when a setter is present and ``OMS -> PLC``
    for output-only signals.  The getter/setter pair remains callable so the
    existing PLC adapters can use the signal without knowing component types.
    """

    name: str
    getter: Callable[[], Any]
    setter: Optional[Callable[[Any], None]] = None
    datatype: type | None = None
    description: str = ""

    @property
    def direction(self) -> str:
        return "PLC -> OMS" if self.setter is not None else "OMS -> PLC"

    def read(self) -> Any:
        return self.getter()

    def write(self, value: Any) -> None:
        if self.setter is None:
            raise TypeError(f"Signal '{self.name}' is read-only")
        self.setter(value)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "direction": self.direction,
            "datatype": self.datatype.__name__ if self.datatype else None,
            "description": self.description,
        }
