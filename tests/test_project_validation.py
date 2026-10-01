import unittest
from project.serialization import validate_project_dict, migrate_project_dict, PROJECT_VERSION

class ProjectValidationTests(unittest.TestCase):
    def test_valid_project_has_no_errors(self):
        self.assertEqual(validate_project_dict({"version": 1, "objects": []}), [])

    def test_future_version_rejected(self):
        errors = validate_project_dict({"version": PROJECT_VERSION + 1, "objects": []})
        self.assertTrue(any(e["field"] == "version" for e in errors))

    def test_invalid_structure_rejected(self):
        errors = validate_project_dict({"version": 1, "objects": {}, "plc_mapping": {}})
        self.assertGreaterEqual(len(errors), 2)

    def test_old_projects_still_migrate(self):
        result = migrate_project_dict({"version": 1, "objects": []})
        self.assertEqual(result["version"], PROJECT_VERSION)

if __name__ == "__main__":
    unittest.main()
