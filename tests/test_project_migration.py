import unittest
from project.serialization import migrate_project_dict, PROJECT_VERSION


class MigrationTests(unittest.TestCase):
    def test_v1_migrates_to_current(self):
        result = migrate_project_dict({"version": 1, "objects": []})
        self.assertEqual(result["version"], PROJECT_VERSION)
        self.assertEqual(result["metadata"]["migrated_from"], 1)


if __name__ == "__main__":
    unittest.main()

    def test_v2_migrates_to_current(self):
        result = migrate_project_dict({"version": 2, "objects": [], "logic_rules": []})
        self.assertEqual(result["version"], PROJECT_VERSION)
        self.assertEqual(result["metadata"]["migrated_from"], 2)

class V3MigrationTests(unittest.TestCase):
    def test_v3_migrates_to_current(self):
        result = migrate_project_dict({"version": 3, "objects": [], "logic_rules": []})
        self.assertEqual(result["version"], PROJECT_VERSION)
        self.assertEqual(result["metadata"]["migrated_from"], 3)
        self.assertEqual(result.get("sequences", []), [])
