-- Reservations protect the free-tier budget before work starts. Once an
-- operation has D1 metadata, settle the conservative charge down to measured
-- usage exactly once. The token makes concurrent settlement idempotent.

ALTER TABLE resource_reservations ADD COLUMN measured_at TEXT;
ALTER TABLE resource_reservations ADD COLUMN measurement_token TEXT;

-- Releases the synthetic read-model charges left by releases before measured
-- settlement existed. The availability lane deliberately keeps another one
-- million rows outside its reservable budget, so this one-time repair remains
-- conservative even though the old requests cannot be measured retroactively.
UPDATE resource_budget_days
   SET reserved_units = MAX(0, reserved_units - COALESCE((
         SELECT SUM(item.reserved_units)
           FROM resource_reservation_items item
           JOIN resource_reservations reservation
             ON reservation.id = item.reservation_id
          WHERE reservation.usage_date = resource_budget_days.usage_date
            AND reservation.lane = resource_budget_days.lane
            AND reservation.state = 'consumed'
            AND reservation.operation_type IN
              ('read_model_refresh', 'custom_read_model')
            AND item.resource_type = resource_budget_days.resource_type
            AND item.resource_key = resource_budget_days.resource_key
            AND item.actual_units = 0
       ), 0)),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE lane = 'availability'
   AND resource_type IN ('d1_rows_read', 'd1_rows_written');

-- The prior release retried provisional daily bars until the foreground
-- provider allowance was gone. Give those intents a clean, immediately due
-- attempt; the application now applies the settlement window before creating
-- new daily intents and retries snapshot anomalies only after the UTC reset.
UPDATE sync_intents
   SET status = 'pending', next_attempt_at = NULL,
       last_error_code = NULL, last_error_message = NULL,
       completed_at = NULL,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE dataset = 'market' AND priority_class = 'current'
   AND status = 'waiting'
   AND last_error_code IN ('invalid_price', 'market_bar_missing');
