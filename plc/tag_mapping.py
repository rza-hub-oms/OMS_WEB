import yaml

class TagMapping:
    def __init__(self, path):
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        self.mappings = data.get("mappings", [])

    def entries(self):
        """Yields (object_tag, io_point, plc_node) tuples."""
        for m in self.mappings:
            yield m["object_tag"], m["io_point"], m["plc_node"]