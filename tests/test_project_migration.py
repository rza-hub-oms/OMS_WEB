import unittest
from project.serialization import migrate_project_dict, PROJECT_VERSION


class MigrationTests(unittest.TestCase):
    def test_v1_migrates_to_current(self):
        result = migrate_project_dict({"version": 1, "objects": []})
        self.assertEqual(result["version"], PROJECT_VERSION)
        self.assertEqual(result["metadata"]["migrated_from"], 1)


if __name__ == "__main__":
    unittest.main()
