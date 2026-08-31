/**
 * Localized notification message builders for all trigger types.
 * Supported languages: en, ru, de, fr, es (matches user_settings.language).
 * Falls back to 'en' for unknown language codes.
 */

export type NotificationLang = 'en' | 'ru' | 'de' | 'fr' | 'es';

export interface NotificationMessage {
  title: string;
  body: string;
}

type MessageBuilders = {
  SOC_BELOW:             (soc: number, threshold: number) => NotificationMessage;
  SOC_ABOVE:             (soc: number, threshold: number) => NotificationMessage;
  CHARGING_STARTED:      ()                               => NotificationMessage;
  CHARGING_COMPLETE:     (soc: number)                    => NotificationMessage;
  VEHICLE_UNLOCKED:      ()                               => NotificationMessage;
  SPEED_ABOVE:           (speed: number, threshold: number) => NotificationMessage;
  NOT_CHARGING_AT_HOME:  (soc: number, threshold: number) => NotificationMessage;
  DEGRADATION_ABOVE:     (value: number, threshold: number) => NotificationMessage;
  VAMPIRE_DRAIN_ABOVE:   (value: number, threshold: number) => NotificationMessage;
};

const MESSAGES: Record<NotificationLang, MessageBuilders> = {
  en: {
    SOC_BELOW:            (soc, t)  => ({ title: `Low Battery — ${soc}%`,              body: `Battery dropped below ${t}%.` }),
    SOC_ABOVE:            (soc, t)  => ({ title: `Battery Charged — ${soc}%`,          body: `Battery is now above ${t}%.` }),
    CHARGING_STARTED:     ()        => ({ title: 'Charging Started',                    body: 'Your vehicle has started charging.' }),
    CHARGING_COMPLETE:    (soc)     => ({ title: 'Charging Complete',                   body: `Battery reached ${soc}%.` }),
    VEHICLE_UNLOCKED:     ()        => ({ title: 'Vehicle Unlocked',                    body: 'Your vehicle has been unlocked.' }),
    SPEED_ABOVE:          (spd, t)  => ({ title: `High Speed — ${spd} km/h`,           body: `Speed exceeded ${t} km/h.` }),
    NOT_CHARGING_AT_HOME: (soc, t)  => ({ title: `Not Charging at Home — ${soc}%`,     body: `Car is at home, battery at ${soc}% (below ${t}%) and not plugged in.` }),
    DEGRADATION_ABOVE:    (val, t)  => ({ title: `Battery Degradation — ${val.toFixed(1)}%`, body: `Battery degradation exceeded ${t}%.` }),
    VAMPIRE_DRAIN_ABOVE:  (val, t)  => ({ title: `High Vampire Drain — ${val.toFixed(2)}%/hr`, body: `Average drain over the last 7 days exceeded ${t}%/hr.` }),
  },
  ru: {
    SOC_BELOW:            (soc, t)  => ({ title: `Низкий заряд — ${soc}%`,             body: `Заряд опустился ниже ${t}%.` }),
    SOC_ABOVE:            (soc, t)  => ({ title: `Заряд — ${soc}%`,                    body: `Заряд поднялся выше ${t}%.` }),
    CHARGING_STARTED:     ()        => ({ title: 'Зарядка началась',                   body: 'Автомобиль начал зарядку.' }),
    CHARGING_COMPLETE:    (soc)     => ({ title: 'Зарядка завершена',                  body: `Аккумулятор заряжен до ${soc}%.` }),
    VEHICLE_UNLOCKED:     ()        => ({ title: 'Авто разблокировано',                body: 'Ваш автомобиль был разблокирован.' }),
    SPEED_ABOVE:          (spd, t)  => ({ title: `Высокая скорость — ${spd} км/ч`,    body: `Скорость превысила ${t} км/ч.` }),
    NOT_CHARGING_AT_HOME: (soc, t)  => ({ title: `Не заряжается дома — ${soc}%`,      body: `Авто дома, заряд ${soc}% (ниже ${t}%), не подключено.` }),
    DEGRADATION_ABOVE:    (val, t)  => ({ title: `Деградация батареи — ${val.toFixed(1)}%`, body: `Деградация батареи превысила ${t}%.` }),
    VAMPIRE_DRAIN_ABOVE:  (val, t)  => ({ title: `Высокий паразитный расход — ${val.toFixed(2)}%/ч`, body: `Средний расход за 7 дней превысил ${t}%/ч.` }),
  },
  de: {
    SOC_BELOW:            (soc, t)  => ({ title: `Niedriger Akku — ${soc}%`,           body: `Akku unter ${t}% gefallen.` }),
    SOC_ABOVE:            (soc, t)  => ({ title: `Akku geladen — ${soc}%`,             body: `Akku ist jetzt über ${t}%.` }),
    CHARGING_STARTED:     ()        => ({ title: 'Laden gestartet',                    body: 'Das Fahrzeug lädt.' }),
    CHARGING_COMPLETE:    (soc)     => ({ title: 'Laden abgeschlossen',                body: `Akku hat ${soc}% erreicht.` }),
    VEHICLE_UNLOCKED:     ()        => ({ title: 'Fahrzeug entsperrt',                 body: 'Das Fahrzeug wurde entsperrt.' }),
    SPEED_ABOVE:          (spd, t)  => ({ title: `Hohe Geschwindigkeit — ${spd} km/h`, body: `Geschwindigkeit überschritt ${t} km/h.` }),
    NOT_CHARGING_AT_HOME: (soc, t)  => ({ title: `Nicht geladen zu Hause — ${soc}%`,  body: `Auto ist zu Hause, Akku bei ${soc}% (unter ${t}%), nicht angeschlossen.` }),
    DEGRADATION_ABOVE:    (val, t)  => ({ title: `Akkudegradation — ${val.toFixed(1)}%`, body: `Akkudegradation überschritt ${t}%.` }),
    VAMPIRE_DRAIN_ABOVE:  (val, t)  => ({ title: `Hoher Standby-Verbrauch — ${val.toFixed(2)}%/h`, body: `Durchschnittlicher Verbrauch der letzten 7 Tage überschritt ${t}%/h.` }),
  },
  fr: {
    SOC_BELOW:            (soc, t)  => ({ title: `Batterie faible — ${soc}%`,          body: `La batterie est descendue sous ${t}%.` }),
    SOC_ABOVE:            (soc, t)  => ({ title: `Batterie chargée — ${soc}%`,         body: `La batterie est maintenant au-dessus de ${t}%.` }),
    CHARGING_STARTED:     ()        => ({ title: 'Charge démarrée',                    body: 'Le véhicule a commencé à se charger.' }),
    CHARGING_COMPLETE:    (soc)     => ({ title: 'Charge terminée',                    body: `La batterie a atteint ${soc}%.` }),
    VEHICLE_UNLOCKED:     ()        => ({ title: 'Véhicule déverrouillé',              body: 'Votre véhicule a été déverrouillé.' }),
    SPEED_ABOVE:          (spd, t)  => ({ title: `Vitesse élevée — ${spd} km/h`,      body: `La vitesse a dépassé ${t} km/h.` }),
    NOT_CHARGING_AT_HOME: (soc, t)  => ({ title: `Non chargé à domicile — ${soc}%`,   body: `La voiture est à la maison, batterie à ${soc}% (sous ${t}%), non branchée.` }),
    DEGRADATION_ABOVE:    (val, t)  => ({ title: `Dégradation batterie — ${val.toFixed(1)}%`, body: `La dégradation a dépassé ${t}%.` }),
    VAMPIRE_DRAIN_ABOVE:  (val, t)  => ({ title: `Décharge passive élevée — ${val.toFixed(2)}%/h`, body: `La consommation moyenne sur 7 jours a dépassé ${t}%/h.` }),
  },
  es: {
    SOC_BELOW:            (soc, t)  => ({ title: `Batería baja — ${soc}%`,             body: `La batería bajó por debajo del ${t}%.` }),
    SOC_ABOVE:            (soc, t)  => ({ title: `Batería cargada — ${soc}%`,          body: `La batería está ahora por encima del ${t}%.` }),
    CHARGING_STARTED:     ()        => ({ title: 'Carga iniciada',                     body: 'El vehículo ha comenzado a cargarse.' }),
    CHARGING_COMPLETE:    (soc)     => ({ title: 'Carga completa',                     body: `La batería alcanzó el ${soc}%.` }),
    VEHICLE_UNLOCKED:     ()        => ({ title: 'Vehículo desbloqueado',              body: 'Tu vehículo ha sido desbloqueado.' }),
    SPEED_ABOVE:          (spd, t)  => ({ title: `Alta velocidad — ${spd} km/h`,      body: `La velocidad superó los ${t} km/h.` }),
    NOT_CHARGING_AT_HOME: (soc, t)  => ({ title: `No cargando en casa — ${soc}%`,     body: `El coche está en casa, batería al ${soc}% (bajo ${t}%), sin enchufar.` }),
    DEGRADATION_ABOVE:    (val, t)  => ({ title: `Degradación batería — ${val.toFixed(1)}%`, body: `La degradación superó el ${t}%.` }),
    VAMPIRE_DRAIN_ABOVE:  (val, t)  => ({ title: `Drenaje vampiro alto — ${val.toFixed(2)}%/h`, body: `El consumo medio de los últimos 7 días superó ${t}%/h.` }),
  },
};

function getLang(code: string | null | undefined): NotificationLang {
  if (code && code in MESSAGES) return code as NotificationLang;
  return 'en';
}

export function getNotificationMessage(
  triggerType: string,
  lang: string | null | undefined,
  params: { soc?: number | null; threshold?: number; speed?: number | null; value?: number },
): NotificationMessage {
  const m = MESSAGES[getLang(lang)];
  const soc       = Math.round(params.soc ?? 0);
  const speed     = Math.round(params.speed ?? 0);
  const threshold = params.threshold ?? 0;
  const value     = params.value ?? 0;

  switch (triggerType) {
    case 'SOC_BELOW':             return m.SOC_BELOW(soc, threshold);
    case 'SOC_ABOVE':             return m.SOC_ABOVE(soc, threshold);
    case 'CHARGING_STARTED':      return m.CHARGING_STARTED();
    case 'CHARGING_COMPLETE':     return m.CHARGING_COMPLETE(soc);
    case 'VEHICLE_UNLOCKED':      return m.VEHICLE_UNLOCKED();
    case 'SPEED_ABOVE':           return m.SPEED_ABOVE(speed, threshold);
    case 'NOT_CHARGING_AT_HOME':  return m.NOT_CHARGING_AT_HOME(soc, threshold);
    case 'DEGRADATION_ABOVE':     return m.DEGRADATION_ABOVE(value, threshold);
    case 'VAMPIRE_DRAIN_ABOVE':   return m.VAMPIRE_DRAIN_ABOVE(value, threshold);
    default:                      return { title: triggerType, body: '' };
  }
}
