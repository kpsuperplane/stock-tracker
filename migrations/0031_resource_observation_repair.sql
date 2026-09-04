-- Reservations are conservative envelopes. Before this repair, consuming an
-- operation without explicit measurements copied its reserved units into the
-- observation table, causing the adaptive p99 envelope to grow by 25% on
-- every delivery. Remove those synthetic observations and restore the five
-- canonical read-model reservations created during the staged rollout to
-- their static envelopes.

DELETE FROM resource_operation_observations;

UPDATE resource_reservation_items
   SET reserved_units = CASE resource_type
         WHEN 'd1_rows_read' THEN 100000
         WHEN 'd1_rows_written' THEN 25
         WHEN 'kv_write' THEN 1
         ELSE reserved_units
       END,
       actual_units = 0
 WHERE reservation_id IN (
   SELECT id FROM resource_reservations
    WHERE operation_type = 'read_model_refresh'
 );

UPDATE resource_budget_days
   SET reserved_units = COALESCE((
         SELECT SUM(item.reserved_units)
           FROM resource_reservation_items AS item
           JOIN resource_reservations AS reservation
             ON reservation.id = item.reservation_id
          WHERE reservation.usage_date = resource_budget_days.usage_date
            AND reservation.lane = resource_budget_days.lane
            AND reservation.state IN ('reserved', 'consumed')
            AND item.resource_type = resource_budget_days.resource_type
            AND item.resource_key = resource_budget_days.resource_key
       ), 0),
       actual_units = 0,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
