import json
import unittest

from core.components.conveyor import ConveyorBehavior
from core.components.motor import MotorBehavior
from core.scene import Scene
from project.model import ProjectSession
from project.serialization import scene_to_project_dict, load_project_dict, PROJECT_VERSION


class ConveyorTests(unittest.TestCase):
    def test_reverse_moves_boxes_and_belt_phase_in_same_direction(self):
        conveyor = ConveyorBehavior("Conveyor_1", width=300, height=70)
        conveyor.set_running(True)
        conveyor.box_positions = [200.0]
        conveyor.set_direction(False)
        conveyor.advance_animation(1000.0)
        self.assertLess(conveyor.box_positions[0], 200.0)
        self.assertLess(conveyor._belt_phase, 43.0)
        self.assertEqual(conveyor.get_direction(), False)

    def test_delta_time_is_not_tied_to_50ms_ticks(self):
        conveyor = ConveyorBehavior("Conveyor_1", width=300, height=70)
        conveyor.set_running(True)
        conveyor.set_speed(100)
        conveyor.box_positions = [0.0]
        conveyor.advance_animation(100.0)
        first = conveyor.box_positions[0]
        conveyor.box_positions = [0.0]
        conveyor.advance_animation(200.0)
        second = conveyor.box_positions[0]
        self.assertAlmostEqual(second, first * 2, places=5)


class SignalTests(unittest.TestCase):
    def test_typed_signal_catalog(self):
        scene = Scene()
        conveyor = scene.create_component("conveyor", 0, 0)
        signals = {s.name: s for s in conveyor.get_io_signals()}
        self.assertIs(signals["running"].datatype, bool)
        self.assertEqual(signals["running"].direction, "PLC -> OMS")
        self.assertEqual(signals["running_status"].direction, "OMS -> PLC")
        self.assertIn("direction", signals)

    def test_scene_tick_uses_elapsed_seconds(self):
        scene = Scene()
        motor = MotorBehavior("Motor_1")
        motor.set_running(True)
        motor.set_speed(100)
        scene.add(motor)
        scene.tick(0.1, simulate=True)
        phase_a = motor.rotation_phase
        scene.tick(0.2, simulate=True)
        self.assertGreater(motor.rotation_phase, phase_a)


class ProjectTests(unittest.TestCase):
    def test_round_trip_and_version(self):
        scene = Scene()
        scene.create_component("conveyor", 10, 20)
        data = scene_to_project_dict(scene, name="Test Machine")
        self.assertEqual(data["version"], PROJECT_VERSION)
        self.assertEqual(data["name"], "Test Machine")

        loaded = Scene()
        info = load_project_dict(loaded, data)
        self.assertEqual(info["name"], "Test Machine")
        self.assertIn("Conveyor_1", loaded.objects)

    def test_rename_updates_references_and_plc_mapping(self):
        scene = Scene()
        conveyor = scene.create_component("conveyor", 0, 0)
        sensor = scene.create_component("sensor", 20, 0)
        cylinder = scene.create_component("cylinder", 40, 0)

        sensor.set_watch_target(conveyor.tag_name)
        cylinder.set_target_tag(conveyor.tag_name)
        scene.plc_mapping = [{
            "object_tag": conveyor.tag_name,
            "io_point": "running",
            "plc_node": "DB1.DBX0.0",
        }]

        self.assertTrue(scene.rename_component("Conveyor_1", "MainConveyor"))
        self.assertNotIn("Conveyor_1", scene.objects)
        self.assertIn("MainConveyor", scene.objects)
        self.assertEqual(sensor.watch_tag, "MainConveyor")
        self.assertEqual(cylinder.target_tag, "MainConveyor")
        self.assertEqual(scene.plc_mapping[0]["object_tag"], "MainConveyor")

        self.assertFalse(scene.rename_component("MainConveyor", "Sensor_1"))
        self.assertIn("MainConveyor", scene.objects)

    def test_sessions_have_independent_scenes(self):
        a = ProjectSession()
        b = ProjectSession()
        a.scene.create_component("conveyor", 0, 0)
        self.assertIn("Conveyor_1", a.scene.objects)
        self.assertNotIn("Conveyor_1", b.scene.objects)


if __name__ == "__main__":
    unittest.main()
