# SLAs

An SLA on a TASK step (`sla.dueAfterSeconds`) is the workflow's DEFAULT. The **effective**
SLA is resolved at execution through the D8 configuration engine
(`workflow.{key}.sla`, DEPARTMENT → FACILITY → ORGANIZATION → the workflow default),
and D7 **snapshots** the resolved value on the SLA timer so a later config change
never moves an in-flight deadline.

This is what lets one authored workflow behave differently per hospital:

```
Org A: workflow.<key>.sla = 15m ; Org B: workflow.<key>.sla = 60m
→ same workflow, effective SLA 900s (A) vs 3600s (B)   (proven in the gate)
```

The builder does not hard-code hospital-specific SLAs; it references the D8-configured
value and shows its provenance in simulation.
