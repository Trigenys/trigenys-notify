-- Initial association explicitly confirmed by the project owner on 2026-10-21.
-- Transport credentials and the fallback ID remain in the Worker secret store.
INSERT INTO notify_whatsapp_groups(session,group_id,group_name,state,last_seen_ms)
VALUES('trigenys-test','120363432964279423@g.us','Xeption app test','available',0)
ON CONFLICT(session,group_id) DO NOTHING;
UPDATE notify_whatsapp_routes SET enabled=0
WHERE project='xeption' AND session='trigenys-test'
  AND group_id='120363408459165821@g.us';
INSERT INTO notify_whatsapp_routes(project,session,group_id,enabled,approved_at)
VALUES('xeption','trigenys-test','120363432964279423@g.us',1,datetime('now'))
ON CONFLICT(project,session,group_id) DO NOTHING;
