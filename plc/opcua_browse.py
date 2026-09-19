# plc/opcua_browse.py
"""
Browses the node tree of a *live, already-connected* OPC UA server, so
the Mapping panel can offer "pick an address" instead of the user
typing each Node ID by hand. Unlike the S7 DB importer, there's no
file to parse here -- OPC UA servers expose their own tag list over
the wire (via UA Browse), so the connected PLC is the source of truth.

Works with either backend's client (AsyncuaPlcSync's asyncua.sync.Client
or OpcuaPlcSync's opcua.Client) since both expose the same synchronous
get_objects_node()/get_node()/get_children()/get_browse_name()/
get_node_class() API -- opcua is the library asyncua originally forked
from. Call this via asyncio.to_thread(); it makes blocking network
calls just like open_connection() does.
"""


def browse_node(client, node_id=None, max_children=200):
    """Returns the direct children of `node_id` (or the server's
    Objects folder if node_id is None/omitted) as a list of:
        {"name", "node_id", "node_class", "is_variable"}
    is_variable marks nodes that can actually be used as a Mapping
    panel address (OPC UA "Variable" nodes); "Object"/"View"/other
    nodes are just for drilling further into the tree.

    Raises whatever the underlying client raises (bad node id,
    connection dropped mid-browse, etc.) -- the caller is expected to
    catch and report it, same as every other PLC call in this app.
    """
    node = client.get_objects_node() if not node_id else client.get_node(node_id)
    children = node.get_children()

    result = []
    for child in children[:max_children]:
        try:
            browse_name = child.get_browse_name().Name
        except Exception:
            browse_name = str(child.nodeid)

        try:
            node_class = child.get_node_class().name
        except Exception:
            node_class = "Unknown"

        result.append({
            "name": browse_name,
            "node_id": child.nodeid.to_string(),
            "node_class": node_class,
            "is_variable": node_class == "Variable",
        })

    result.sort(key=lambda n: (n["node_class"] != "Variable", n["name"].lower()))
    return result
