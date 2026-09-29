from core.trends import TrendRecorder


def test_trend_recorder_samples_numeric_values_at_interval():
    values = {"Motor.speed": 10.0, "Motor.current": 2}
    recorder = TrendRecorder(interval_s=1.0, max_samples=10)
    recorder.configure(list(values))

    assert recorder.sample(values.get, 0.4) is False
    assert recorder.sample(values.get, 0.6) is True
    snapshot = recorder.snapshot()
    assert snapshot["selected"] == ["Motor.speed", "Motor.current"]
    assert snapshot["samples"][0]["values"] == {"Motor.speed": 10.0, "Motor.current": 2.0}


def test_trend_recorder_ignores_boolean_tags_and_is_bounded():
    values = {"Motor.running": True, "Motor.speed": 25}
    recorder = TrendRecorder(interval_s=0.0, max_samples=2)
    recorder.configure(list(values))

    recorder.sample(values.get, 0.0)
    values["Motor.speed"] = 30
    recorder.sample(values.get, 0.0)
    values["Motor.speed"] = 35
    recorder.sample(values.get, 0.0)

    samples = recorder.snapshot()["samples"]
    assert len(samples) == 2
    assert all("Motor.running" not in s["values"] for s in samples)
    assert [s["values"]["Motor.speed"] for s in samples] == [30.0, 35.0]


def test_trend_recorder_clear_and_reconfigure():
    values = {"A": 1.0, "B": 2.0}
    recorder = TrendRecorder(interval_s=0.0)
    recorder.configure(["A"])
    recorder.sample(values.get, 0.0)
    assert recorder.snapshot()["samples"]

    recorder.configure(["B"])
    assert recorder.snapshot()["samples"] == []
    assert recorder.snapshot()["selected"] == ["B"]
