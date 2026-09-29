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


from core.components.emergency_push_button import EmergencyPushButtonBehavior
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


class EmergencyStopTagTests(unittest.TestCase):
    def test_emergency_push_button_exposes_pressed_tag(self):
        scene = Scene()
        button = EmergencyPushButtonBehavior("EStop_1")
        scene.add(button)
        scene.tags.sync()

        self.assertIn("EStop_1.pressed", scene.tags._system)
        self.assertFalse(scene.tags.read("EStop_1.pressed"))

        button.set_pressed(True)
        scene.tags.sync()
        self.assertTrue(scene.tags.read("EStop_1.pressed"))

    def test_emergency_stop_alarm_uses_pressed_tag(self):
        scene = Scene()
        button = EmergencyPushButtonBehavior("EStop_1")
        scene.add(button)
        scene.alarm_engine.set_definitions([{
            "id": "estop_alarm",
            "name": "Emergency Stop",
            "severity": "critical",
            "expression": 'tag("EStop_1.pressed")',
            "enabled": True,
            "latched": True,
        }])

        scene.tags.sync()
        self.assertEqual(scene.alarm_engine.evaluate(), [])

        button.set_pressed(True)
        scene.tags.sync()
        active = scene.alarm_engine.evaluate()
        self.assertEqual(len(active), 1)
        self.assertEqual(active[0]["name"], "Emergency Stop")


class DiagnosticsTests(unittest.TestCase):
    def test_clean_scene_diagnostics_has_no_errors(self):
        scene = Scene()
        scene.create_component("conveyor", 0, 0)
        result = scene.diagnostics()
        self.assertTrue(result["valid"])
        self.assertEqual(result["counts"]["error"], 0)

    def test_diagnostics_finds_missing_alarm_tag_and_mapping_target(self):
        scene = Scene()
        scene.create_component("conveyor", 0, 0)
        scene.alarm_engine.set_definitions([{
            "id": "alarm_1",
            "name": "Bad Alarm",
            "severity": "critical",
            "expression": 'tag("Missing.fault")',
            "enabled": True,
        }])
        scene.plc_mapping = [{
            "object_tag": "Missing",
            "io_point": "running",
            "plc_node": "DB1.DBX0.0",
        }]
        result = scene.diagnostics()
        self.assertFalse(result["valid"])
        messages = [item["message"] for item in result["issues"]]
        self.assertTrue(any("Alarm expression" in message for message in messages))
        self.assertTrue(any("Mapped component" in message for message in messages))

    def test_diagnostics_finds_hierarchy_cycle_and_duplicate_connection(self):
        scene = Scene()
        a = scene.create_component("conveyor", 0, 0)
        b = scene.create_component("motor", 100, 0)
        scene.set_parent(a.tag_name, b.tag_name)
        # Simulate malformed project data; the public set_parent API blocks this.
        b.set_parent_tag(a.tag_name)
        scene.add_connection(a.tag_name, b.tag_name, "control")
        scene.connections.append({"source": a.tag_name, "target": b.tag_name, "kind": "control", "label": ""})
        result = scene.diagnostics()
        self.assertFalse(result["valid"])
        self.assertTrue(any(item["category"] == "Hierarchy" for item in result["issues"]))
        self.assertTrue(any("Duplicate engineering connection" in item["message"] for item in result["issues"]))


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
        self.assertEqual(data["version"], PROJECT_VERSION)
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


class TagRegistryTests(unittest.TestCase):
    def test_component_tags_are_centralized(self):
        scene = Scene()
        scene.create_component("conveyor", 0, 0)
        tags = {row["name"]: row for row in scene.tag_catalog()}
        self.assertIn("Conveyor_1.running", tags)
        self.assertIn("Conveyor_1.speed", tags)
        self.assertEqual(tags["Conveyor_1.running"]["object_tag"], "Conveyor_1")

    def test_internal_tag_round_trip(self):
        scene = Scene()
        scene.add_tag("ProductionCount", "int", 12, "Good parts", True)
        self.assertEqual(scene.tags.read("ProductionCount"), 12)
        data = scene_to_project_dict(scene)
        loaded = Scene()
        load_project_dict(loaded, data)
        self.assertEqual(loaded.tags.read("ProductionCount"), 12)
        self.assertEqual(loaded.tags.get("ProductionCount").description, "Good parts")

    def test_component_tag_writes_through_registry(self):
        scene = Scene()
        motor = scene.create_component("motor", 0, 0)
        self.assertTrue(scene.set_tag("Motor_1.running", True))
        self.assertTrue(motor.running)

class TagExpressionTests(unittest.TestCase):
    def test_internal_tag_expression_reads_component_tag(self):
        scene = Scene()
        sensor = SensorBehavior("Sensor_1")
        scene.add(sensor)
        scene.add_tag("LineReady", "bool", False)
        scene.set_tag_expression("LineReady", 'tag("Sensor_1.detected")')
        sensor.set_detected(True)
        scene.tags.evaluate_expressions()
        self.assertTrue(scene.tags.read("LineReady"))

    def test_internal_tag_expression_supports_boolean_and_comparison(self):
        scene = Scene()
        sensor = SensorBehavior("Sensor_1")
        motor = MotorBehavior("Motor_1")
        scene.add(sensor); scene.add(motor)
        scene.add_tag("HighSpeedReady", "bool", False)
        scene.set_tag_expression(
            "HighSpeedReady",
            'tag("Sensor_1.detected") and tag("Motor_1.speed") > 80',
        )
        sensor.set_detected(True)
        motor.set_speed(90)
        scene.tags.evaluate_expressions()
        self.assertTrue(scene.tags.read("HighSpeedReady"))

    def test_expression_error_is_reported_without_python_execution(self):
        scene = Scene()
        scene.add_tag("Safe", "bool", False)
        scene.set_tag_expression("Safe", '__import__("os").system("echo bad")')
        scene.tags.evaluate_expressions()
        tag = scene.tags.get("Safe")
        self.assertTrue(tag.expression_error)
        self.assertFalse(tag.value)

    def test_expression_survives_project_round_trip(self):
        scene = Scene()
        scene.add_tag("LineReady", "bool", False)
        scene.set_tag_expression("LineReady", 'tag("Sensor_1.detected")')
        data = scene_to_project_dict(scene)
        loaded = Scene()
        load_project_dict(loaded, data)
        self.assertEqual(loaded.tags.get("LineReady").expression, 'tag("Sensor_1.detected")')
        self.assertEqual(data["version"], PROJECT_VERSION)



def test_internal_tag_can_bind_to_component_signal_and_read_write():
    from core.scene import Scene

    scene = Scene()
    motor = scene.create_component("motor", 0, 0)
    tag = scene.add_tag("MotorStart", "bool", False)
    assert scene.bind_tag("MotorStart", motor.tag_name, "running")
    bound = scene.tags.get("MotorStart")
    assert bound.object_tag == motor.tag_name
    assert bound.io_point == "running"
    assert bound.direction == "PLC -> OMS"
    assert scene.tags.read("MotorStart") is False
    assert scene.tags.write("MotorStart", True)
    assert motor.running is True


def test_internal_tag_mapping_resolves_through_tag_registry():
    from core.scene import Scene

    scene = Scene()
    scene.add_tag("LineReady", "bool", False)
    scene.plc_mapping = [{"tag_name": "LineReady", "point": "Internal", "plc_node": "DB1.DBX0.0"}]
    from plc.plc_sync import S7PlcSync
    sync = S7PlcSync(scene, "127.0.0.1", 0, 1)
    resolved = sync._resolve_mapped_points()
    assert len(resolved) == 1
    assert resolved[0]["tag_name"] == "LineReady"
    assert resolved[0]["getter"]() is False


def test_bound_internal_tag_persists_in_project():
    from core.scene import Scene
    from project.serialization import scene_to_project_dict, load_project_dict

    scene = Scene()
    motor = scene.create_component("motor", 0, 0)
    scene.add_tag("MotorStart", "bool", False)
    assert scene.bind_tag("MotorStart", motor.tag_name, "running")
    data = scene_to_project_dict(scene)

    restored = Scene()
    load_project_dict(restored, data)
    tag = restored.tags.get("MotorStart")
    assert tag is not None
    assert tag.object_tag == motor.tag_name
    assert tag.io_point == "running"
    assert restored.tags.write("MotorStart", True)
    assert restored.objects[motor.tag_name].running is True


def test_alarm_engine_uses_tags_and_latched_acknowledgement():
    from core.scene import Scene

    scene = Scene()
    scene.tags.add_custom("TestAlarm", "bool", True)
    scene.alarm_engine.set_definitions([
        {"id": "a1", "name": "Test alarm", "severity": "critical",
         "expression": 'tag("TestAlarm")', "latched": True}
    ])

    scene.tick(0.05, simulate=True)
    assert len(scene.alarm_engine.active()) == 1
    assert scene.alarm_engine.history[0]["event"] == "active"

    scene.tags.write("TestAlarm", False)
    scene.tick(0.05, simulate=True)
    assert len(scene.alarm_engine.active()) == 1  # latched until ACK

    assert scene.alarm_engine.acknowledge("a1") is True
    assert scene.alarm_engine.history[0]["event"] == "acknowledged"
    scene.tick(0.05, simulate=True)
    assert scene.alarm_engine.active() == []
    assert scene.alarm_engine.history[0]["event"] == "cleared"
    assert scene.alarm_engine.history[1]["event"] == "acknowledged"
    assert scene.alarm_engine.history[2]["event"] == "active"


def test_alarm_project_roundtrip():
    from core.scene import Scene
    from project.serialization import scene_to_project_dict, load_project_dict

    scene = Scene()
    scene.create_component("conveyor", 10, 20)
    scene.alarm_engine.set_definitions([
        {"id": "a1", "name": "Motor fault", "severity": "warning",
         "expression": 'tag("Conveyor_1.fault")'}
    ])
    payload = scene_to_project_dict(scene, name="AlarmProject")

    other = Scene()
    info = load_project_dict(other, payload)
    assert info["name"] == "AlarmProject"
    assert other.alarm_engine.definitions[0]["expression"] == 'tag("Conveyor_1.fault")'


class EngineeringStructureTests(unittest.TestCase):
    def test_machine_hierarchy_rejects_cycles(self):
        scene = Scene()
        a = scene.create_component("conveyor", 0, 0)
        b = scene.create_component("sensor", 100, 0)
        c = scene.create_component("motor", 200, 0)
        self.assertTrue(scene.set_parent(b.tag_name, a.tag_name))
        self.assertTrue(scene.set_parent(c.tag_name, b.tag_name))
        self.assertFalse(scene.set_parent(a.tag_name, c.tag_name))
        self.assertEqual(b.parent_tag, a.tag_name)
        self.assertEqual(c.parent_tag, b.tag_name)

    def test_connections_are_created_validated_and_cleaned_on_delete(self):
        scene = Scene()
        a = scene.create_component("conveyor", 0, 0)
        b = scene.create_component("sensor", 100, 0)
        self.assertTrue(scene.add_connection(a.tag_name, b.tag_name, "signal"))
        self.assertFalse(scene.add_connection(a.tag_name, b.tag_name, "signal"))
        self.assertEqual(scene.validate_connections(), [])
        scene.remove(b.tag_name)
        self.assertEqual(scene.connections, [])

    def test_hierarchy_and_connections_round_trip(self):
        scene = Scene()
        a = scene.create_component("conveyor", 0, 0)
        b = scene.create_component("sensor", 100, 0)
        self.assertTrue(scene.set_parent(b.tag_name, a.tag_name))
        self.assertTrue(scene.add_connection(a.tag_name, b.tag_name, "signal", "box detected"))
        payload = scene_to_project_dict(scene)
        restored = Scene()
        load_project_dict(restored, payload)
        self.assertEqual(restored.objects[b.tag_name].parent_tag, a.tag_name)
        self.assertEqual(restored.connections[0]["kind"], "signal")
        self.assertEqual(restored.connections[0]["label"], "box detected")

    def test_emergency_stop_exposes_pressed_tag(self):
        scene = Scene()
        estop = scene.create_component("emergency_push_button", 0, 0)
        names = {signal.name for signal in estop.get_io_signals()}
        self.assertIn("pressed", names)

class HierarchyTests(unittest.TestCase):
    def test_set_parent_and_prevent_cycle(self):
        scene = Scene()
        scene.create_component("conveyor", 0, 0)
        scene.create_component("sensor", 10, 10)
        scene.create_component("motor", 20, 20)
        self.assertTrue(scene.set_parent("Sensor_1", "Conveyor_1"))
        self.assertTrue(scene.set_parent("Motor_1", "Conveyor_1"))
        self.assertFalse(scene.set_parent("Conveyor_1", "Sensor_1"))
        tree = scene.hierarchy()
        self.assertEqual(tree[0]["tag_name"], "Conveyor_1")
        self.assertEqual({c["tag_name"] for c in tree[0]["children"]}, {"Motor_1", "Sensor_1"})

    def test_move_child_back_to_root(self):
        scene = Scene()
        scene.create_component("conveyor", 0, 0)
        scene.create_component("sensor", 10, 10)
        self.assertTrue(scene.set_parent("Sensor_1", "Conveyor_1"))
        self.assertTrue(scene.set_parent("Sensor_1", None))
        roots = {node["tag_name"] for node in scene.hierarchy()}
        self.assertEqual(roots, {"Conveyor_1", "Sensor_1"})
