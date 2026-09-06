import crypto from 'node:crypto';
import logger from '../config/logger.js';

/**
 * Attaches a correlation id to every request (spec §16).
 *
 * An inbound `X-Request-Id` is honoured so a trace started by a gateway or a
 * calling service survives the hop, but it is length-capped and stripped of
 * anything but safe characters — the value ends up in log lines and a response
 * header, so it must not be attacker-controlled free text.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function requestId(req, res, next) {
  const inbound = req.get('x-request-id');
  const id = inbound && SAFE_ID.test(inbound) ? inbound : crypto.randomUUID();

  req.id = id;
  // A child logger means every downstream log line carries the id without callers
  // having to remember to pass it.
  req.log = logger.child({ requestId: id });
  res.setHeader('X-Request-Id', id);

  next();
}

export default requestId;
