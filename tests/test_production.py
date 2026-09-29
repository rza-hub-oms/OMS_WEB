from core.production import ProductionTracker


def test_production_counts_rising_edges_and_rejects():
    values = {"Part.done": False, "Part.reject": False, "Line.running": True}
    tracker = ProductionTracker()
    tracker.configure({
        "production_trigger": "Part.done",
        "reject_trigger": "Part.reject",
        "running_tag": "Line.running",
        "ideal_cycle_s": 1.0,
    })

    tracker.tick(values.get, 1.0, active=True)
    assert tracker.total_count == 0
    values["Part.done"] = True
    tracker.tick(values.get, 0.1, active=True)
    assert tracker.total_count == 1
    tracker.tick(values.get, 0.1, active=True)
    assert tracker.total_count == 1
    values["Part.done"] = False
    tracker.tick(values.get, 0.1, active=True)
    values["Part.done"] = True
    values["Part.reject"] = True
    tracker.tick(values.get, 0.1, active=True)
    assert tracker.total_count == 2
    assert tracker.reject_count == 1
    assert tracker.good_count == 1


def test_production_reset_and_snapshot_oee_foundation():
    values = {"done": False, "run": True}
    tracker = ProductionTracker()
    tracker.configure({"production_trigger": "done", "running_tag": "run", "ideal_cycle_s": 2.0})
    tracker.tick(values.get, 2.0)
    values["done"] = True
    tracker.tick(values.get, 0.1)
    snap = tracker.snapshot()
    assert snap["total_count"] == 1
    assert snap["good_count"] == 1
    assert 0.0 <= snap["availability"] <= 1.0
    assert 0.0 <= snap["performance"] <= 1.0
    assert 0.0 <= snap["quality"] <= 1.0
    assert 0.0 <= snap["oee"] <= 1.0
    tracker.reset()
    assert tracker.snapshot()["total_count"] == 0


def test_production_missing_optional_tags_do_not_break():
    tracker = ProductionTracker()
    tracker.configure({"production_trigger": "done", "reject_trigger": "missing", "running_tag": "run"})
    tracker.tick({"done": False}.get, 1.0)
    assert tracker.snapshot()["total_count"] == 0
