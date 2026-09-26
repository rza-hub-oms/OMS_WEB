import json
import unittest

from core.components.conveyor import ConveyorBehavior
from core.components.motor import MotorBehavior
from core.components.sensor import SensorBehavior
from core.components.push_button import PushButtonBehavior
from core.components.cylinder import CylinderBehavior
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




class CylinderRelationTests(unittest.TestCase):
    def test_cylinder_physically_actuates_sensor_target(self):
        scene = Scene()
        cylinder = CylinderBehavior("Cylinder_1", x=0, y=0, width=40, height=20)
        sensor = SensorBehavior("Sensor_1", x=40, y=0, width=20, height=20)
        cylinder.target_tag = sensor.tag_name
        cylinder.extended = True
        cylinder.progress = 1.0

        scene.add(cylinder)
        scene.add(sensor)
        scene.tick(0.05)

        self.assertTrue(sensor.detected)

        cylinder.extended = False
        cylinder.progress = 0.0
        scene.tick(0.05)
        self.assertFalse(sensor.detected)

    def test_cylinder_physically_presses_push_button(self):
        scene = Scene()
        cylinder = CylinderBehavior("Cylinder_1", x=0, y=0, width=40, height=20)
        button = PushButtonBehavior("PushButton_1", x=40, y=0, width=20, height=20)
        cylinder.target_tag = button.tag_name
        cylinder.extended = True
        cylinder.progress = 1.0

        scene.add(cylinder)
        scene.add(button)
        scene.tick(0.05)

        self.assertTrue(button.pressed)

        cylinder.extended = False
        cylinder.progress = 0.0
        scene.tick(0.05)
        self.assertFalse(button.pressed)


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

class LogicTests(unittest.TestCase):
    def test_sensor_drives_cylinder_in_simulation(self):
        scene = Scene()
        button = PushButtonBehavior("PushButton_1")
        cylinder = CylinderBehavior("Cylinder_1")
        scene.add(button)
        scene.add(cylinder)
        button.set_pressed(True)
        scene.logic_rules = [{
            "enabled": True,
            "operator": "truthy",
            "source": {"object_tag": "PushButton_1", "io_point": "pressed_signal"},
            "destination": {"object_tag": "Cylinder_1", "io_point": "extend"},
            "true_value": True,
            "false_value": False,
        }]
        scene.tick(0.05, simulate=True, logic_enabled=True)
        self.assertTrue(cylinder.extended or cylinder.progress > 0)

    def test_logic_does_not_run_without_simulation_logic_flag(self):
        scene = Scene()
        button = PushButtonBehavior("PushButton_1")
        cylinder = CylinderBehavior("Cylinder_1")
        scene.add(button)
        scene.add(cylinder)
        button.set_pressed(True)
        scene.logic_rules = [{
            "enabled": True,
            "operator": "truthy",
            "source": {"object_tag": "PushButton_1", "io_point": "pressed_signal"},
            "destination": {"object_tag": "Cylinder_1", "io_point": "extend"},
            "true_value": True,
            "false_value": False,
        }]
        scene.tick(0.05, simulate=True, logic_enabled=False)
        self.assertFalse(cylinder.extended)

    def test_logic_rules_round_trip(self):
        scene = Scene()
        scene.create_component("sensor", 0, 0)
        scene.create_component("cylinder", 100, 0)
        scene.logic_rules = [{
            "enabled": True,
            "operator": "truthy",
            "source": {"object_tag": "PushButton_1", "io_point": "pressed_signal"},
            "destination": {"object_tag": "Cylinder_1", "io_point": "extend"},
            "true_value": True,
            "false_value": False,
        }]
        data = scene_to_project_dict(scene)
        loaded = Scene()
        load_project_dict(loaded, data)
        self.assertEqual(loaded.logic_rules, scene.logic_rules)



class LogicSequenceTests(unittest.TestCase):
    def _scene(self):
        scene = Scene()
        button = PushButtonBehavior("PushButton_1")
        motor = MotorBehavior("Motor_1")
        scene.add(button)
        scene.add(motor)
        return scene, button, motor

    def test_rising_edge_is_one_simulation_tick(self):
        scene, button, motor = self._scene()
        scene.logic_rules = [{
            "enabled": True,
            "operator": "rising",
            "source": {"object_tag": "PushButton_1", "io_point": "pressed_signal"},
            "destination": {"object_tag": "Motor_1", "io_point": "running"},
            "true_value": True,
            "false_value": False,
        }]
        button.set_pressed(True)
        scene.tick(0.05, simulate=True, logic_enabled=True)
        self.assertTrue(motor.running)
        button.set_pressed(False)
        scene.tick(0.05, simulate=True, logic_enabled=True)
        self.assertFalse(motor.running)

    def test_on_delay_waits_for_elapsed_time(self):
        scene, button, motor = self._scene()
        scene.logic_rules = [{
            "enabled": True,
            "operator": "truthy",
            "source": {"object_tag": "PushButton_1", "io_point": "pressed_signal"},
            "destination": {"object_tag": "Motor_1", "io_point": "running"},
            "delay_ms": 200,
            "true_value": True,
            "false_value": False,
        }]
        button.set_pressed(True)
        scene.tick(0.05, simulate=True, logic_enabled=True)
        self.assertFalse(motor.running)
        scene.tick(0.10, simulate=True, logic_enabled=True)
        self.assertFalse(motor.running)
        scene.tick(0.10, simulate=True, logic_enabled=True)
        self.assertTrue(motor.running)

    def test_logic_runtime_resets_when_rules_change(self):
        scene, button, motor = self._scene()
        scene.logic_rules = [{
            "enabled": True,
            "operator": "rising",
            "source": {"object_tag": "PushButton_1", "io_point": "pressed_signal"},
            "destination": {"object_tag": "Motor_1", "io_point": "running"},
            "true_value": True,
            "false_value": False,
        }]
        button.set_pressed(True)
        scene.tick(0.05, simulate=True, logic_enabled=True)
        self.assertTrue(motor.running)
        scene.logic_rules = []
        scene.logic_engine.reset()
        button.set_pressed(False)
        scene.logic_rules = [{
            "enabled": True,
            "operator": "rising",
            "source": {"object_tag": "PushButton_1", "io_point": "pressed_signal"},
            "destination": {"object_tag": "Motor_1", "io_point": "running"},
            "true_value": True,
            "false_value": False,
        }]
        button.set_pressed(True)
        scene.tick(0.05, simulate=True, logic_enabled=True)
        self.assertTrue(motor.running)

class SequenceEngineTests(unittest.TestCase):
    def _scene(self):
        scene = Scene()
        button = PushButtonBehavior("Start")
        motor = MotorBehavior("Motor")
        scene.add(button); scene.add(motor)
        return scene, button, motor

    def test_sequence_advances_and_runs_actions(self):
        scene, button, motor = self._scene()
        scene.sequences = [{
            "id": "seq1", "name": "Start motor", "enabled": True, "auto_start": True,
            "steps": [
                {"name": "WAIT", "actions": [], "transition": {"object_tag": "Start", "io_point": "pressed_signal", "operator": "truthy"}},
                {"name": "RUN", "actions": [{"destination": {"object_tag": "Motor", "io_point": "running"}, "value": True}], "transition": {"object_tag": "Start", "io_point": "pressed_signal", "operator": "falling"}},
            ],
        }]
        scene.tick(0.05, simulate=True, logic_enabled=True)
        self.assertEqual(scene.sequence_engine.last_status[0]["step"], "WAIT")
        button.set_pressed(True)
        scene.tick(0.05, simulate=True, logic_enabled=True)
        self.assertTrue(motor.running)
        self.assertEqual(scene.sequence_engine.last_status[0]["step"], "RUN")

    def test_sequence_timeout_faults(self):
        scene, button, motor = self._scene()
        scene.sequences = [{"id": "seq1", "auto_start": True, "steps": [{"name": "WAIT", "timeout_ms": 100, "on_timeout": "fault", "transition": {"object_tag": "Start", "io_point": "pressed_signal", "operator": "truthy"}}]}]
        scene.tick(0.05, simulate=True, logic_enabled=True)
        scene.tick(0.10, simulate=True, logic_enabled=True)
        self.assertEqual(scene.sequence_engine.last_status[0]["status"], "fault")
        self.assertIn("Timeout", scene.sequence_engine.last_status[0]["fault"])

    def test_sequence_round_trip_and_migration(self):
        scene, button, motor = self._scene()
        scene.sequences = [{"id": "seq1", "steps": [{"name": "A", "actions": []}]}]
        data = scene_to_project_dict(scene)
        self.assertEqual(data["version"], 5)
        loaded = Scene(); load_project_dict(loaded, data)
        self.assertEqual(loaded.sequences, scene.sequences)

    def test_sequence_rising_transition_is_not_consumed_twice(self):
        scene, button, motor = self._scene()
        scene.sequences = [{"id": "seq1", "auto_start": True, "steps": [
            {"name": "WAIT", "actions": [], "transition": {"object_tag": "Start", "io_point": "pressed_signal", "operator": "rising"}},
            {"name": "RUN", "actions": [{"destination": {"object_tag": "Motor", "io_point": "running"}, "value": True}], "transition": {"object_tag": "Start", "io_point": "pressed_signal", "operator": "truthy"}},
        ]}]
        scene.tick(0.05, simulate=True, logic_enabled=True)
        button.set_pressed(True)
        scene.tick(0.05, simulate=True, logic_enabled=True)
        self.assertTrue(motor.running)
