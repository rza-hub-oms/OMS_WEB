"""Central OMS tag/variable registry.

A Tag is the stable data contract between machine objects, simulation,
PLC mapping, alarms and Runtime. Component I/O points are automatically
projected into the registry; user-defined memory tags can be added for
derived state, counters, recipes and future alarm/trend features.
"""
from __future__ import annotations
from dataclasses import dataclass, asdict
from typing import Any
import ast
import math
import operator


@dataclass
class Tag:
    name: str
    datatype: str = "bool"
    direction: str = "Internal"
    description: str = ""
    object_tag: str | None = None
    io_point: str | None = None
    value: Any = False
    writable: bool = True
    system: bool = False
    expression: str = ""
    expression_error: str = ""

    def to_dict(self) -> dict:
        return asdict(self)



class TagExpressionError(ValueError):
    pass


class _SafeExpression:
    """Small, deterministic expression evaluator for derived OMS tags.

    Expressions reference tags with tag("Sensor_1.detected") and support
    boolean, arithmetic and comparison operators plus min/max/abs/round.
    No Python names, attributes, imports, indexing or arbitrary calls are
    permitted.
    """
    ALLOWED_BIN = {ast.Add: operator.add, ast.Sub: operator.sub,
                   ast.Mult: operator.mul, ast.Div: operator.truediv,
                   ast.Mod: operator.mod, ast.Pow: operator.pow}
    ALLOWED_CMP = {ast.Eq: operator.eq, ast.NotEq: operator.ne,
                   ast.Lt: operator.lt, ast.LtE: operator.le,
                   ast.Gt: operator.gt, ast.GtE: operator.ge}

    def __init__(self, resolver):
        self.resolver = resolver

    def evaluate(self, expression: str):
        try:
            tree = ast.parse(expression, mode="eval")
        except SyntaxError as exc:
            raise TagExpressionError(f"Invalid expression: {exc.msg}") from exc
        return self._node(tree.body)

    def _node(self, node):
        if isinstance(node, ast.Constant):
            if isinstance(node.value, (bool, int, float, str)) or node.value is None:
                return node.value
            raise TagExpressionError("Unsupported constant")
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.Not, ast.USub, ast.UAdd)):
            value = self._node(node.operand)
            if isinstance(node.op, ast.Not): return not bool(value)
            return -value if isinstance(node.op, ast.USub) else +value
        if isinstance(node, ast.BoolOp) and isinstance(node.op, (ast.And, ast.Or)):
            values = [self._node(v) for v in node.values]
            return all(bool(v) for v in values) if isinstance(node.op, ast.And) else any(bool(v) for v in values)
        if isinstance(node, ast.BinOp) and type(node.op) in self.ALLOWED_BIN:
            try: return self.ALLOWED_BIN[type(node.op)](self._node(node.left), self._node(node.right))
            except Exception as exc: raise TagExpressionError(str(exc)) from exc
        if isinstance(node, ast.Compare):
            left = self._node(node.left)
            for op, comparator in zip(node.ops, node.comparators):
                if type(op) not in self.ALLOWED_CMP:
                    raise TagExpressionError("Unsupported comparison")
                right = self._node(comparator)
                if not self.ALLOWED_CMP[type(op)](left, right): return False
                left = right
            return True
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and not node.keywords:
            if node.func.id == "tag" and len(node.args) == 1:
                name = self._node(node.args[0])
                if not isinstance(name, str): raise TagExpressionError("tag() requires a tag name")
                return self.resolver(name)
            funcs = {"min": min, "max": max, "abs": abs, "round": round}
            if node.func.id in funcs:
                return funcs[node.func.id](*[self._node(a) for a in node.args])
        raise TagExpressionError("Unsupported expression syntax")


class TagRegistry:
    def __init__(self, scene):
        self.scene = scene
        self.custom: dict[str, Tag] = {}
        self._system: dict[str, Tag] = {}

    def sync(self) -> None:
        """Rebuild component-backed tags while preserving custom tags."""
        system = {}
        for object_tag in sorted(self.scene.objects):
            obj = self.scene.objects[object_tag]
            for signal in obj.get_io_signals():
                name = f"{object_tag}.{signal.name}"
                system[name] = Tag(
                    name=name,
                    datatype=signal.datatype.__name__ if signal.datatype else "any",
                    direction=signal.direction,
                    description=signal.description,
                    object_tag=object_tag,
                    io_point=signal.name,
                    value=signal.read(),
                    writable=signal.setter is not None,
                    system=True,
                )
        self._system = system

    def remove_object(self, object_tag: str) -> None:
        self._system = {
            name: tag for name, tag in self._system.items()
            if tag.object_tag != object_tag
        }

    def rename_object(self, old: str, new: str) -> None:
        # System tags are regenerated on next sync. Custom tags can
        # explicitly reference a component and must follow its rename.
        for tag in self.custom.values():
            if tag.object_tag == old:
                tag.object_tag = new

    def evaluate_expressions(self) -> list[dict]:
        """Evaluate derived custom tags after component simulation.

        A few passes allow simple chains (A -> B -> C) without exposing
        arbitrary Python execution. Cycles are detected by the lack of
        convergence and reported on the affected tags.
        """
        derived = [t for t in self.custom.values() if t.expression.strip()]
        for tag in derived:
            tag.expression_error = ""
        if not derived:
            return []

        evaluator = _SafeExpression(self.read)
        for _ in range(max(1, len(derived))):
            changed = False
            for tag in derived:
                try:
                    value = evaluator.evaluate(tag.expression.strip())
                    value = self._coerce_datatype(value, tag.datatype)
                    if value != tag.value:
                        tag.value = value
                        changed = True
                except (TagExpressionError, KeyError, TypeError, ValueError, ZeroDivisionError, OverflowError) as exc:
                    tag.expression_error = str(exc)
            if not changed:
                break
        return [{"name": t.name, "error": t.expression_error} for t in derived if t.expression_error]

    @staticmethod
    def _coerce_datatype(value, datatype):
        dtype = str(datatype).lower()
        if dtype in ("bool", "boolean"): return bool(value)
        if dtype in ("int", "integer"): return int(value)
        if dtype in ("float", "real"): return float(value)
        if dtype in ("string", "str"): return str(value)
        return value

    def bind_custom(self, name: str, object_tag: str, io_point: str) -> bool:
        tag = self.custom.get(name)
        if tag is None:
            return False
        obj = self.scene.objects.get(object_tag)
        if obj is None:
            return False
        signal = next((s for s in obj.get_io_signals() if s.name == io_point), None)
        if signal is None:
            return False
        tag.object_tag = object_tag
        tag.io_point = io_point
        tag.direction = signal.direction
        tag.description = tag.description or signal.description
        tag.writable = signal.setter is not None
        # Connect and fx are independent: connecting to a component no
        # longer clears a stored expression. read() below always returns
        # the live signal's value while object_tag is set, so a stored
        # expression just sits unused (not evaluated against anything
        # visible) until the tag is disconnected, at which point it takes
        # over again automatically -- nothing is lost either way.
        tag.value = signal.read()
        return True

    def unbind_custom(self, name: str) -> bool:
        tag = self.custom.get(name)
        if tag is None:
            return False
        tag.object_tag = None
        tag.io_point = None
        tag.direction = "Internal"
        tag.writable = True
        return True

    def set_expression(self, name: str, expression: str) -> bool:
        tag = self.custom.get(name)
        if tag is None:
            return False
        tag.expression = str(expression or "").strip()
        tag.expression_error = ""
        return True

    def all(self) -> list[Tag]:
        self.sync()
        return [*self._system.values(), *self.custom.values()]

    def get(self, name: str) -> Tag | None:
        self.sync()
        return self._system.get(name) or self.custom.get(name)

    def read(self, name: str) -> Any:
        tag = self.get(name)
        if tag is None:
            raise KeyError(name)
        if tag.object_tag is not None:
            obj = self.scene.objects.get(tag.object_tag)
            if obj is None:
                return None
            signal = obj.get_io_signals()
            for item in signal:
                if item.name == tag.io_point:
                    return item.read()
            return None
        return tag.value

    def write(self, name: str, value: Any) -> bool:
        tag = self.get(name)
        if tag is None or not tag.writable:
            return False
        if tag.object_tag is not None:
            obj = self.scene.objects.get(tag.object_tag)
            if obj is None:
                return False
            signal = next((s for s in obj.get_io_signals() if s.name == tag.io_point), None)
            if signal is None or signal.setter is None:
                return False
            signal.write(value)
            return True
        tag.value = value
        return True

    def add_custom(self, name: str, datatype="bool", value=False,
                   description="", writable=True, expression="") -> Tag:
        name = str(name).strip()
        if not name or "." in name or name in self._system or name in self.custom:
            raise ValueError("Tag name must be unique and may not contain '.'.")
        tag = Tag(name=name, datatype=str(datatype), direction="Internal",
                  description=str(description), value=value,
                  writable=bool(writable), system=False, expression=str(expression or ""))
        self.custom[name] = tag
        return tag

    def remove_custom(self, name: str) -> bool:
        return self.custom.pop(name, None) is not None

    def to_dict(self) -> list[dict]:
        return [tag.to_dict() for tag in self.custom.values()]

    def load_custom(self, rows) -> None:
        self.custom.clear()
        for row in rows or []:
            if not isinstance(row, dict):
                continue
            try:
                self.add_custom(
                    row.get("name", ""),
                    row.get("datatype", "bool"),
                    row.get("value", False),
                    row.get("description", ""),
                    row.get("writable", True),
                    row.get("expression", ""),
                )
                if row.get("object_tag") and row.get("io_point"):
                    self.bind_custom(row.get("name", ""), row.get("object_tag"), row.get("io_point"))
            except ValueError:
                continue
