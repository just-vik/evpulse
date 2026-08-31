'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
  X, Plus, Trash2, Clock, MapPin, Car, Globe, Webhook, ChevronDown, Save, Loader,
} from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────

export interface RuleCondition {
  field: 'time_of_day' | 'vehicle_id' | 'location';
  op: string;
  value: any;
}

export interface RuleAction {
  type: 'webhook';
  config: {
    url: string;
    method?: string;
  };
}

interface Props {
  open: boolean;
  rule: { id: string; name: string; conditions?: RuleCondition[] | null; actions?: RuleAction[] | null } | null;
  vehicles: Array<{ id: string; displayName?: string; model: string; trim?: string }>;
  onClose: () => void;
  onSave: (ruleId: string, conditions: RuleCondition[], actions: RuleAction[]) => Promise<void>;
}

// ── Condition editor row ──────────────────────────────────────────────────

function ConditionRow({
  cond,
  vehicles,
  onChange,
  onDelete,
}: {
  cond: RuleCondition;
  vehicles: Props['vehicles'];
  onChange: (c: RuleCondition) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex items-start gap-2 p-3 rounded-xl border border-[hsl(var(--border)/0.55)] bg-[hsl(var(--secondary)/0.3)]">
      {/* Field selector */}
      <select
        value={cond.field}
        onChange={e => {
          const f = e.target.value as RuleCondition['field'];
          const defaults: Record<RuleCondition['field'], Partial<RuleCondition>> = {
            time_of_day: { op: 'between', value: [22, 6] },
            vehicle_id:  { op: 'is', value: '' },
            location:    { op: 'near', value: { lat: 0, lng: 0, radiusM: 500 } },
          };
          onChange({ ...cond, field: f, ...defaults[f] });
        }}
        className="bg-[hsl(var(--background))] border border-[hsl(var(--border)/0.6)] rounded-lg px-2 py-1.5 text-xs text-foreground focus:outline-none shrink-0"
      >
        <option value="time_of_day">{t('ruleEditor.condition.timeOfDay', { defaultValue: 'Time of day' })}</option>
        <option value="vehicle_id">{t('ruleEditor.condition.vehicle', { defaultValue: 'Vehicle' })}</option>
        <option value="location">{t('ruleEditor.condition.location', { defaultValue: 'Location' })}</option>
      </select>

      {/* Field-specific editors */}
      <div className="flex-1 min-w-0">
        {cond.field === 'time_of_day' && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground">{t('ruleEditor.condition.from', { defaultValue: 'from' })}</span>
            <input
              type="number" min={0} max={23} value={cond.value?.[0] ?? 22}
              onChange={e => onChange({ ...cond, value: [+e.target.value, cond.value?.[1] ?? 6] })}
              className="w-14 bg-[hsl(var(--background))] border border-[hsl(var(--border)/0.6)] rounded-lg px-2 py-1 text-xs text-foreground focus:outline-none"
            />
            <span className="text-xs text-muted-foreground">{t('ruleEditor.condition.to', { defaultValue: 'to' })}</span>
            <input
              type="number" min={0} max={23} value={cond.value?.[1] ?? 6}
              onChange={e => onChange({ ...cond, value: [cond.value?.[0] ?? 22, +e.target.value] })}
              className="w-14 bg-[hsl(var(--background))] border border-[hsl(var(--border)/0.6)] rounded-lg px-2 py-1 text-xs text-foreground focus:outline-none"
            />
            <span className="text-xs text-muted-foreground">UTC</span>
          </div>
        )}

        {cond.field === 'vehicle_id' && (
          <div className="flex items-center gap-2">
            <select
              value={cond.op}
              onChange={e => onChange({ ...cond, op: e.target.value })}
              className="bg-[hsl(var(--background))] border border-[hsl(var(--border)/0.6)] rounded-lg px-2 py-1.5 text-xs text-foreground focus:outline-none"
            >
              <option value="is">{t('ruleEditor.condition.is', { defaultValue: 'is' })}</option>
              <option value="not">{t('ruleEditor.condition.isNot', { defaultValue: 'is not' })}</option>
            </select>
            <select
              value={cond.value ?? ''}
              onChange={e => onChange({ ...cond, value: e.target.value })}
              className="flex-1 bg-[hsl(var(--background))] border border-[hsl(var(--border)/0.6)] rounded-lg px-2 py-1.5 text-xs text-foreground focus:outline-none"
            >
              <option value="">{t('ruleEditor.condition.anyVehicle', { defaultValue: 'Any vehicle' })}</option>
              {vehicles.map(v => (
                <option key={v.id} value={v.id}>
                  {v.displayName ?? `${v.model}${v.trim ? ' ' + v.trim : ''}`}
                </option>
              ))}
            </select>
          </div>
        )}

        {cond.field === 'location' && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={cond.op}
                onChange={e => onChange({ ...cond, op: e.target.value })}
                className="bg-[hsl(var(--background))] border border-[hsl(var(--border)/0.6)] rounded-lg px-2 py-1.5 text-xs text-foreground focus:outline-none"
              >
                <option value="near">{t('ruleEditor.condition.near', { defaultValue: 'near' })}</option>
                <option value="away">{t('ruleEditor.condition.away', { defaultValue: 'away from' })}</option>
              </select>
              <input
                type="number" placeholder="lat"
                value={cond.value?.lat ?? 0}
                onChange={e => onChange({ ...cond, value: { ...cond.value, lat: +e.target.value } })}
                className="w-20 bg-[hsl(var(--background))] border border-[hsl(var(--border)/0.6)] rounded-lg px-2 py-1 text-xs text-foreground focus:outline-none"
              />
              <input
                type="number" placeholder="lng"
                value={cond.value?.lng ?? 0}
                onChange={e => onChange({ ...cond, value: { ...cond.value, lng: +e.target.value } })}
                className="w-20 bg-[hsl(var(--background))] border border-[hsl(var(--border)/0.6)] rounded-lg px-2 py-1 text-xs text-foreground focus:outline-none"
              />
              <input
                type="number" placeholder="radius m"
                value={cond.value?.radiusM ?? 500}
                onChange={e => onChange({ ...cond, value: { ...cond.value, radiusM: +e.target.value } })}
                className="w-20 bg-[hsl(var(--background))] border border-[hsl(var(--border)/0.6)] rounded-lg px-2 py-1 text-xs text-foreground focus:outline-none"
              />
              <span className="text-xs text-muted-foreground">m</span>
            </div>
          </div>
        )}
      </div>

      <button onClick={onDelete} className="shrink-0 p-1 text-muted-foreground hover:text-red-400 transition-colors">
        <Trash2 size={13} />
      </button>
    </div>
  );
}

// ── Action editor row ─────────────────────────────────────────────────────

function ActionRow({
  action,
  onChange,
  onDelete,
}: {
  action: RuleAction;
  onChange: (a: RuleAction) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex items-start gap-2 p-3 rounded-xl border border-[hsl(var(--border)/0.55)] bg-[hsl(var(--secondary)/0.3)]">
      <div className="w-7 h-7 rounded-lg bg-violet-500/12 flex items-center justify-center shrink-0 mt-0.5">
        <Globe size={13} className="text-violet-400" />
      </div>
      <div className="flex-1 space-y-1.5 min-w-0">
        <div className="flex items-center gap-2">
          <select
            value={action.config.method ?? 'POST'}
            onChange={e => onChange({ ...action, config: { ...action.config, method: e.target.value } })}
            className="bg-[hsl(var(--background))] border border-[hsl(var(--border)/0.6)] rounded-lg px-2 py-1.5 text-xs text-foreground focus:outline-none w-20 shrink-0"
          >
            <option>POST</option>
            <option>GET</option>
            <option>PUT</option>
          </select>
          <input
            type="url"
            placeholder="https://your-webhook-url.com/hook"
            value={action.config.url}
            onChange={e => onChange({ ...action, config: { ...action.config, url: e.target.value } })}
            className="flex-1 min-w-0 bg-[hsl(var(--background))] border border-[hsl(var(--border)/0.6)] rounded-lg px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-violet-500/50"
          />
        </div>
        <p className="text-[10px] text-muted-foreground/70">
          {t('ruleEditor.action.webhookHint', { defaultValue: 'Receives: ruleId, title, body, vehicleId, firedAt' })}
        </p>
      </div>
      <button onClick={onDelete} className="shrink-0 p-1 text-muted-foreground hover:text-red-400 transition-colors">
        <Trash2 size={13} />
      </button>
    </div>
  );
}

// ── RuleEditorDrawer ──────────────────────────────────────────────────────

export default function RuleEditorDrawer({ open, rule, vehicles, onClose, onSave }: Props) {
  const { t } = useTranslation();
  const [conditions, setConditions] = useState<RuleCondition[]>([]);
  const [actions, setActions]       = useState<RuleAction[]>([]);
  const [saving, setSaving]         = useState(false);

  useEffect(() => {
    if (rule) {
      setConditions(Array.isArray(rule.conditions) ? rule.conditions : []);
      setActions(Array.isArray(rule.actions) ? rule.actions : []);
    }
  }, [rule]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    if (open) window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const addCondition = () => setConditions(c => [...c, { field: 'time_of_day', op: 'between', value: [22, 6] }]);
  const addAction    = () => setActions(a => [...a, { type: 'webhook', config: { url: '', method: 'POST' } }]);

  const handleSave = async () => {
    if (!rule) return;
    setSaving(true);
    try {
      await onSave(rule.id, conditions, actions);
      onClose();
    } catch { /* silent */ }
    setSaving(false);
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
            onClick={onClose}
          />

          {/* Drawer */}
          <motion.div
            initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 380, damping: 38 }}
            className="fixed bottom-0 left-0 right-0 z-50 max-h-[90dvh] overflow-y-auto
                       bg-[hsl(var(--card))] border-t border-[hsl(var(--border)/0.7)] rounded-t-3xl"
          >
            {/* Handle */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 rounded-full bg-[hsl(var(--border)/0.7)]" />
            </div>

            <div className="px-5 pb-8 space-y-5">
              {/* Header */}
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold text-foreground">
                    {t('ruleEditor.title', { defaultValue: 'Edit Rule' })}
                  </h2>
                  <p className="text-xs text-muted-foreground truncate max-w-[260px]">{rule?.name}</p>
                </div>
                <button
                  onClick={onClose}
                  className="w-8 h-8 flex items-center justify-center rounded-full bg-[hsl(var(--secondary)/0.5)] text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X size={16} />
                </button>
              </div>

              {/* Conditions section */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">
                      {t('ruleEditor.conditions.title', { defaultValue: 'Conditions' })}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {t('ruleEditor.conditions.hint', { defaultValue: 'Rule only fires when ALL conditions pass' })}
                    </p>
                  </div>
                  <button
                    onClick={addCondition}
                    className="flex items-center gap-1 text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors px-2 py-1 rounded-lg hover:bg-blue-500/10"
                  >
                    <Plus size={13} />
                    {t('ruleEditor.conditions.add', { defaultValue: 'Add' })}
                  </button>
                </div>

                {conditions.length === 0 ? (
                  <p className="text-xs text-muted-foreground/60 px-1">
                    {t('ruleEditor.conditions.empty', { defaultValue: 'No conditions — rule fires for any context.' })}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {conditions.map((c, i) => (
                      <ConditionRow
                        key={i}
                        cond={c}
                        vehicles={vehicles}
                        onChange={updated => setConditions(prev => prev.map((x, j) => j === i ? updated : x))}
                        onDelete={() => setConditions(prev => prev.filter((_, j) => j !== i))}
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* Divider */}
              <div className="border-t border-[hsl(var(--border)/0.4)]" />

              {/* Actions section */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">
                      {t('ruleEditor.actions.title', { defaultValue: 'Additional Actions' })}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {t('ruleEditor.actions.hint', { defaultValue: 'Run webhooks in addition to notifications' })}
                    </p>
                  </div>
                  <button
                    onClick={addAction}
                    className="flex items-center gap-1 text-xs font-medium text-violet-400 hover:text-violet-300 transition-colors px-2 py-1 rounded-lg hover:bg-violet-500/10"
                  >
                    <Plus size={13} />
                    {t('ruleEditor.actions.addWebhook', { defaultValue: 'Webhook' })}
                  </button>
                </div>

                {actions.length === 0 ? (
                  <p className="text-xs text-muted-foreground/60 px-1">
                    {t('ruleEditor.actions.empty', { defaultValue: 'No extra actions — only in-app / push notifications.' })}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {actions.map((a, i) => (
                      <ActionRow
                        key={i}
                        action={a}
                        onChange={updated => setActions(prev => prev.map((x, j) => j === i ? updated : x))}
                        onDelete={() => setActions(prev => prev.filter((_, j) => j !== i))}
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* Save button */}
              <button
                onClick={handleSave}
                disabled={saving}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl text-sm font-semibold
                           bg-[hsl(var(--brand-h)_var(--brand-s)_var(--brand-l-500))] text-white
                           hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {saving ? <Loader size={15} className="animate-spin" /> : <Save size={15} />}
                {t('ruleEditor.save', { defaultValue: 'Save changes' })}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
