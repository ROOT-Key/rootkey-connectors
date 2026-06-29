output "worker_name" {
  description = "Name of the deployed Cloudflare Worker."
  value       = cloudflare_workers_script.connector.script_name
}

output "events_queue_id" {
  description = "ID of the main events queue (R2 event notifications publish here)."
  value       = cloudflare_queue.events.id
}

output "events_queue_name" {
  description = "Name of the main events queue."
  value       = cloudflare_queue.events.queue_name
}

output "dlq_queue_id" {
  description = "ID of the dead-letter queue. Messages that fail max_retries times on the main queue land here for human inspection."
  value       = cloudflare_queue.dlq.id
}

output "dlq_queue_name" {
  description = "Name of the dead-letter queue. Monitor this — non-zero depth means at least one file did not reach ROOTKey after all retries."
  value       = cloudflare_queue.dlq.queue_name
}

output "r2_event_notification_id" {
  description = "ID of the R2 event-notification binding that routes object-created events to the queue."
  value       = cloudflare_r2_bucket_event_notification.rootkey.id
}
