# OMS Web v8

This release adds the central signal workflow requested for internal tags.

## Internal tag -> component

Open **Inspector > Tags**, create an internal tag, then click **Connect**.
Choose a component and one of its I/O signals. The internal tag becomes an
alias to that signal and follows its live value/direction.

## Internal tag -> PLC Mapping

Connected and unconnected internal tags are listed in **PLC Mapping**.
Enter a PLC address directly or press **Search** beside the tag. If a TIA DB
source or PLC tag-table export has been parsed through **Import DB Tags**, the
Search dialog shows the parsed addresses and lets you select one.

The same mapping can then be used by the PLC synchronization layer through
the central tag registry.
