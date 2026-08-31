'use client';

import React, { useState } from 'react';
import { Plus, Trash2, Clock, Loader } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { apiClient } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import type { Automation } from '@/types/api';

const COMMAND_KEYS = [
  { value: 'climate-on',     labelKey: 'settings.vehicles.schedules.commands.climateOn',  emoji: '🌡️', actionType: 'climate',  actionTarget: 'climate-on'   },
  { value: 'climate-off',    labelKey: 'settings.vehicles.schedules.commands.climateOff', emoji: '❄️', actionType: 'climate',  actionTarget: 'climate-off'  },
  { value: 'start-charging', labelKey: 'settings.vehicles.schedules.commands.startCharge',emoji: '⚡', actionType: 'charging', actionTarget: 'start-charge' },
  { value: 'stop-charging',  labelKey: 'settings.vehicles.schedules.commands.stopCharge', emoji: '🔌', actionType: 'charging', actionTarget: 'stop-charge'  },
  { value: 'lock',           labelKey: 'settings.vehicles.schedules.commands.lock',       emoji: '🔒', actionType: 'command',  actionTarget: 'lock'         },
] as const;

const DAY_LABELS_KEYS = ['settings.vehicles.schedules.days.sun', 'settings.vehicles.schedules.days.mon', 'settings.vehicles.schedules.days.tue', 'settings.vehicles.schedules.days.wed', 'settings.vehicles.schedules.days.thu', 'settings.vehicles.schedules.days.fri', 'settings.vehicles.schedules.days.sat'];
const DAY_SHORT_KEYS  = ['settings.vehicles.schedules.days.sunShort', 'settings.vehicles.schedules.days.monShort', 'settings.vehicles.schedules.days.tueShort', 'settings.vehicles.schedules.days.wedShort', 'settings.vehicles.schedules.days.thuShort', 'settings.vehicles.schedules.days.friShort', 'settings.vehicles.schedules.days.satShort'];

function timeToCron(time: string, weekDays: number[]): string {
  const [h, m] = time.split(':').map(Number);
  const days = weekDays.length === 7 ? '*' : weekDays.sort((a, b) => a - b).join(',');
  return `${m} ${h} * * ${days}`;
}

function cronToTime(cron: string): string {
  const parts = cron.split(' ');
  if (parts.length < 2) return '?';
  const m = parts[0].padStart(2, '0');
  const h = parts[1].padStart(2, '0');
  return `${h}:${m}`;
}

function cronToDays(cron: string, t: (k: string) => string): string {
  const parts = cron.split(' ');
  if (parts.length < 5) return '?';
  const daysStr = parts[4];
  if (daysStr === '*') return t('settings.vehicles.schedules.daily');
  return daysStr.split(',').map(d => t(DAY_LABELS_KEYS[Number(d)] ?? d)).join(', ');
}

function commandLabel(a: Automation, t: (k: string) => string): string {
  const target = a.actions?.[0]?.target;
  const cmd = COMMAND_KEYS.find(c => c.actionTarget === target);
  return cmd ? t(cmd.labelKey) : (target ?? '?');
}
function commandEmoji(a: Automation): string {
  const target = a.actions?.[0]?.target;
  return COMMAND_KEYS.find(c => c.actionTarget === target)?.emoji ?? '⚙️';
}

interface Vehicle { id: string; displayName?: string; vin?: string }

interface Props {
  /** Pass a single vehicleId for backwards-compat, or an array of vehicles */
  vehicleId?: string;
  vehicles?: Vehicle[];
}

export function ScheduledCommandsSection({ vehicleId, vehicles }: Props) {
  const { accessToken } = useAuthStore();
  const { t } = useTranslation();
  const qc = useQueryClient();

  // Resolve vehicle list
  const allVehicles: Vehicle[] = vehicles ?? (vehicleId ? [{ id: vehicleId }] : []);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string>(allVehicles[0]?.id ?? '');

  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({
    command: 'climate-on',
    time: '07:30',
    weekDays: [1, 2, 3, 4, 5],
    name: '',
  });

  const { data: all = [], isLoading, isError } = useQuery({
    queryKey: ['automations'],
    queryFn: () => apiClient.getAutomations(accessToken!),
    enabled: !!accessToken,
    retry: false,
  });

  const scheduled = (all as Automation[]).filter(
    a => a.schedule?.type === 'time-based' && (!a.vehicleId || a.vehicleId === selectedVehicleId),
  );

  const createMutation = useMutation({
    mutationFn: (data: Partial<Automation>) => apiClient.createAutomation(data, accessToken!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['automations'] });
      setShowAdd(false);
      setForm({ command: 'climate-on', time: '07:30', weekDays: [1, 2, 3, 4, 5], name: '' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiClient.deleteAutomation(id, accessToken!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automations'] }),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiClient.updateAutomation(id, { enabled }, accessToken!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automations'] }),
  });

  function toggleDay(day: number) {
    setForm(prev => ({
      ...prev,
      weekDays: prev.weekDays.includes(day)
        ? prev.weekDays.filter(d => d !== day)
        : [...prev.weekDays, day],
    }));
  }

  function handleCreate() {
    if (form.weekDays.length === 0 || !selectedVehicleId) return;
    const cmd = COMMAND_KEYS.find(c => c.value === form.command)!;
    const cron = timeToCron(form.time, form.weekDays);
    const name = form.name.trim() || `${t(cmd.labelKey)} @ ${form.time}`;
    createMutation.mutate({
      name,
      vehicleId: selectedVehicleId,
      enabled: true,
      conditions: [],
      actions: [{ type: cmd.actionType as any, target: cmd.actionTarget as any, parameters: {} }],
      schedule: { type: 'time-based', cronExpression: cron, weekDays: form.weekDays },
    });
  }

  if (isError || allVehicles.length === 0) return null;

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <Clock size={14} className="text-violet-400" />
            {t('settings.vehicles.schedules.title')}
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {t('settings.vehicles.schedules.subtitle')}
          </p>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition"
        >
          <Plus size={14} /> {t('settings.vehicles.schedules.addSchedule')}
        </button>
      </div>

      {/* Vehicle selector for multi-vehicle accounts */}
      {allVehicles.length > 1 && (
        <select
          value={selectedVehicleId}
          onChange={e => setSelectedVehicleId(e.target.value)}
          className="w-full mb-4 bg-[hsl(var(--background))] border border-[hsl(var(--border)/0.7)] rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-blue-500"
        >
          {allVehicles.map(v => (
            <option key={v.id} value={v.id}>
              {v.displayName ?? v.vin ?? v.id}
            </option>
          ))}
        </select>
      )}

      {/* Add form */}
      {showAdd && (
        <div className="mb-4 p-4 bg-[hsl(var(--secondary)/0.4)] border border-[hsl(var(--border)/0.6)] rounded-xl space-y-3">
          <select
            value={form.command}
            onChange={e => setForm(p => ({ ...p, command: e.target.value }))}
            className="w-full bg-[hsl(var(--background))] border border-[hsl(var(--border)/0.7)] rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-blue-500"
          >
            {COMMAND_KEYS.map(c => (
              <option key={c.value} value={c.value}>
                {c.emoji} {t(c.labelKey)}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground w-12 shrink-0">{t('settings.vehicles.schedules.time')}</span>
            <input
              type="time"
              value={form.time}
              onChange={e => setForm(p => ({ ...p, time: e.target.value }))}
              className="flex-1 bg-[hsl(var(--background))] border border-[hsl(var(--border)/0.7)] rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-12 shrink-0">{t('settings.vehicles.schedules.daysLabel')}</span>
            <div className="flex gap-1">
              {DAY_SHORT_KEYS.map((key, i) => (
                <button
                  key={i}
                  onClick={() => toggleDay(i)}
                  className={`w-7 h-7 rounded-lg text-xs font-semibold transition ${
                    form.weekDays.includes(i)
                      ? 'bg-blue-500/20 border border-blue-500/50 text-blue-300'
                      : 'border border-[hsl(var(--border)/0.85)] text-muted-foreground hover:border-[hsl(var(--border))] hover:text-foreground'
                  }`}
                >
                  {t(key)}
                </button>
              ))}
            </div>
          </div>

          <input
            type="text"
            placeholder={t('settings.vehicles.schedules.namePlaceholder')}
            value={form.name}
            onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
            className="w-full bg-[hsl(var(--background))] border border-[hsl(var(--border)/0.7)] rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-blue-500"
          />

          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              disabled={createMutation.isPending || form.weekDays.length === 0}
              className="btn btn-primary text-xs flex-1 flex items-center justify-center gap-1 disabled:opacity-60"
            >
              {createMutation.isPending ? <Loader size={12} className="animate-spin" /> : <Plus size={12} />}
              {t('settings.vehicles.schedules.create')}
            </button>
            <button
              onClick={() => setShowAdd(false)}
              className="btn btn-ghost text-xs px-4 border border-[hsl(var(--border)/0.8)]"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {isLoading && <div className="skeleton h-12 rounded-xl" />}

      {!isLoading && scheduled.length === 0 && !showAdd && (
        <p className="text-sm text-muted-foreground text-center py-6">
          {t('settings.vehicles.schedules.empty')}
        </p>
      )}

      {scheduled.length > 0 && (
        <div className="space-y-2">
          {scheduled.map(a => (
            <div
              key={a.id}
              className="flex items-center gap-3 p-3 bg-[hsl(var(--secondary)/0.4)] rounded-xl border border-[hsl(var(--border)/0.5)]"
            >
              <span className="text-base shrink-0">{commandEmoji(a)}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{a.name || commandLabel(a, t)}</p>
                <p className="text-xs text-muted-foreground">
                  {cronToDays(a.schedule?.cronExpression ?? '', t)} · {cronToTime(a.schedule?.cronExpression ?? '')}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => toggleMutation.mutate({ id: a.id, enabled: !a.enabled })}
                  disabled={toggleMutation.isPending}
                  className={`text-xs px-2 py-1 rounded-lg border transition ${
                    a.enabled
                      ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                      : 'border-[hsl(var(--border)/0.85)] text-muted-foreground'
                  }`}
                >
                  {a.enabled ? t('common.on') : t('common.off')}
                </button>
                <button
                  onClick={() => deleteMutation.mutate(a.id)}
                  disabled={deleteMutation.isPending}
                  className="text-muted-foreground hover:text-red-400 transition"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
