# Triggers

The trigger picker is generated from the **D6 event catalogue** (`builderMetadata()`),
never a hard-coded list. Only events actually present in the catalogue can be selected,
and unknown events/versions are impossible to publish (the D7 validator rejects them).

Each trigger option exposes its allow-listed condition context (§7):

```
event.type, event.aggregateType, event.aggregateId, event.organizationId,
event.facilityId, payload.<approved field>   (derived from the event's Zod payload)
```

A trigger is `{ eventType, eventVersion, condition? }`. The optional condition gates
instance creation (see [conditions](conditions.md)). Human-readable labels are shown;
stable machine identifiers are stored.
