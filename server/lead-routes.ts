import type { Hono } from 'hono';
import {
  availableSlots,
  bookAppointment,
  draftOutreachEmail,
  getLead,
  getLeadByBookingToken,
  leadDashboardSummary,
  LEAD_CATEGORIES,
  listAppointments,
  listDrafts,
  listLeads,
  listOwnerNotifications,
  markNotificationRead,
  seedLeadsIfNeeded,
  updateLeadStatus,
  type LeadStatus,
} from './leads';

const ALLOWED_STATUS = new Set<LeadStatus>([
  'new',
  'reviewed',
  'approved',
  'draft_ready',
  'booked',
  'declined',
  'closed',
]);

export function registerLeadRoutes(
  app: Hono,
  requireAdmin: (c: { req: { header: (name: string) => string | undefined } }) => unknown,
) {
  app.get('/api/admin/leads/summary', (c) => {
    if (!requireAdmin(c)) return c.json({ ok: false }, 401);
    return c.json({ ok: true, summary: leadDashboardSummary(), categories: LEAD_CATEGORIES });
  });

  app.get('/api/admin/leads', (c) => {
    if (!requireAdmin(c)) return c.json({ ok: false }, 401);
    const status = c.req.query('status') || undefined;
    const category = c.req.query('category') || undefined;
    const city = c.req.query('city') || undefined;
    const q = c.req.query('q') || undefined;
    return c.json({
      ok: true,
      leads: listLeads({ status, category, city, q }),
      summary: leadDashboardSummary(),
      categories: LEAD_CATEGORIES,
    });
  });

  app.post('/api/admin/leads/seed', async (c) => {
    if (!requireAdmin(c)) return c.json({ ok: false }, 401);
    const body = await c.req.json<{ force?: boolean }>().catch(() => ({ force: false }));
    const result = seedLeadsIfNeeded(Boolean(body.force));
    return c.json({ ok: true, ...result, leads: listLeads() });
  });

  app.get('/api/admin/leads/notifications', (c) => {
    if (!requireAdmin(c)) return c.json({ ok: false }, 401);
    return c.json({ ok: true, notifications: listOwnerNotifications() });
  });

  app.post('/api/admin/leads/notifications/:id/read', (c) => {
    if (!requireAdmin(c)) return c.json({ ok: false }, 401);
    markNotificationRead(c.req.param('id'));
    return c.json({ ok: true, notifications: listOwnerNotifications() });
  });

  app.get('/api/admin/leads/appointments', (c) => {
    if (!requireAdmin(c)) return c.json({ ok: false }, 401);
    return c.json({ ok: true, appointments: listAppointments() });
  });

  app.get('/api/admin/leads/:id', (c) => {
    if (!requireAdmin(c)) return c.json({ ok: false }, 401);
    const lead = getLead(c.req.param('id'));
    if (!lead) return c.json({ ok: false, message: 'Lead not found.' }, 404);
    return c.json({
      ok: true,
      lead,
      drafts: listDrafts(lead.id),
      appointments: listAppointments(lead.id),
    });
  });

  app.post('/api/admin/leads/:id/status', async (c) => {
    if (!requireAdmin(c)) return c.json({ ok: false }, 401);
    const { status } = await c.req.json<{ status?: string }>();
    if (!status || !ALLOWED_STATUS.has(status as LeadStatus)) {
      return c.json({ ok: false, message: 'Invalid lead status.' }, 400);
    }
    const lead = updateLeadStatus(c.req.param('id'), status as LeadStatus);
    if (!lead) return c.json({ ok: false, message: 'Lead not found.' }, 404);
    return c.json({ ok: true, lead });
  });

  app.post('/api/admin/leads/:id/draft-email', (c) => {
    if (!requireAdmin(c)) return c.json({ ok: false }, 401);
    try {
      const draft = draftOutreachEmail(c.req.param('id'));
      if (!draft) return c.json({ ok: false, message: 'Lead not found.' }, 404);
      return c.json({
        ok: true,
        draft,
        message: 'Draft created. Outreach is NOT auto-sent — copy and send manually when ready.',
        auto_sent: false,
      });
    } catch (error) {
      return c.json({ ok: false, message: error instanceof Error ? error.message : 'Could not create draft.' }, 400);
    }
  });

  // Public booking (token-gated). No admin session required.
  app.get('/api/book/:token', (c) => {
    const lead = getLeadByBookingToken(c.req.param('token'));
    if (!lead) return c.json({ ok: false, message: 'Booking link not found.' }, 404);
    if (!['approved', 'draft_ready', 'booked'].includes(lead.lead_status)) {
      return c.json({ ok: false, message: 'This booking link is not active.' }, 400);
    }
    return c.json({
      ok: true,
      business_name: lead.business_name,
      city: lead.city,
      category: lead.category,
      slots: availableSlots(),
      min_notice_hours: 24,
      note: 'This is a 15-minute video call to review a personalized website demo. The demo is shown on the call — not sent beforehand.',
    });
  });

  app.post('/api/book/:token', async (c) => {
    try {
      const body = await c.req.json<{ slotIso?: string; name?: string; email?: string; notes?: string }>();
      if (!body.slotIso || !body.name?.trim() || !body.email?.trim()) {
        return c.json({ ok: false, message: 'Name, email, and time are required.' }, 400);
      }
      if (!/^\S+@\S+\.\S+$/.test(body.email.trim())) {
        return c.json({ ok: false, message: 'Enter a valid email.' }, 400);
      }
      const booked = await bookAppointment(c.req.param('token'), {
        slotIso: body.slotIso,
        name: body.name,
        email: body.email,
        notes: body.notes,
      });
      return c.json({
        ok: true,
        appointment_id: booked.appointment_id,
        scheduled_at: booked.scheduled_at,
        message: 'Booked. The BBLS owner has been notified to prepare your personalized demo.',
      });
    } catch (error) {
      return c.json({ ok: false, message: error instanceof Error ? error.message : 'Could not book.' }, 400);
    }
  });
}
