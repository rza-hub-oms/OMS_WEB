from asyncua.sync import Client

class PlcClient:
    def __init__(self, endpoint_url):
        self.client = Client(endpoint_url)
        self.connected = False

    def connect(self):
        self.client.connect()
        self.connected = True

    def disconnect(self):
        if self.connected:
            self.client.disconnect()
            self.connected = False

    def read(self, node_id):
        node = self.client.get_node(node_id)
        return node.read_value()

    def write(self, node_id, value):
        node = self.client.get_node(node_id)
        node.write_value(value)