from core.sim_object import SimObject

class PushButton(SimObject):
    def __init__(self, name: str, id: str):
        super().__init__(name, id)
        self.is_pressed = False

    def press(self):
        self.is_pressed = True
        self.update_signals()

    def release(self):
        self.is_pressed = False
        self.update_signals()

    def update_signals(self):
        # Hier kommt die Logik zur Signalübertragung an die PLC / API hin
        pass