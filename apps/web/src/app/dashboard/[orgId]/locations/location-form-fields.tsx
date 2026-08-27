import type { LocationRecord, OpeningHourInput } from '@uttily/core';
import { LOCATION_HOUR_SLOTS, LOCATION_WEEKDAYS, toTimeInputValue } from './location-form';

interface LocationFormFieldsProps {
  location?: LocationRecord;
  openingHours?: OpeningHourInput[];
}

export function LocationFormFields({ location, openingHours = [] }: LocationFormFieldsProps) {
  const hoursByDay = new Map<number, OpeningHourInput[]>();
  for (const hour of openingHours) {
    const dayHours = hoursByDay.get(hour.weekday) ?? [];
    dayHours.push(hour);
    hoursByDay.set(hour.weekday, dayHours);
  }

  return (
    <>
      <label htmlFor="name">Nom public de l’établissement</label>
      <input
        id="name"
        name="name"
        type="text"
        required
        minLength={2}
        defaultValue={location?.name ?? ''}
      />

      <label htmlFor="timeZone">Fuseau IANA</label>
      <input
        id="timeZone"
        name="timeZone"
        type="text"
        required
        defaultValue={location?.timeZone ?? 'Europe/Paris'}
      />

      <fieldset>
        <legend>Adresse de retrait</legend>
        <label htmlFor="addressLine1">Adresse</label>
        <input
          id="addressLine1"
          name="addressLine1"
          type="text"
          autoComplete="street-address"
          defaultValue={location?.addressLine1 ?? ''}
        />

        <label htmlFor="addressLine2">Complément d’adresse</label>
        <input
          id="addressLine2"
          name="addressLine2"
          type="text"
          autoComplete="address-line2"
          defaultValue={location?.addressLine2 ?? ''}
        />

        <label htmlFor="city">Ville</label>
        <input
          id="city"
          name="city"
          type="text"
          autoComplete="address-level2"
          defaultValue={location?.city ?? ''}
        />

        <label htmlFor="postalCode">Code postal</label>
        <input
          id="postalCode"
          name="postalCode"
          type="text"
          autoComplete="postal-code"
          defaultValue={location?.postalCode ?? ''}
        />

        <label htmlFor="countryCode">Pays (ISO 3166-1 alpha-2)</label>
        <input
          id="countryCode"
          name="countryCode"
          type="text"
          maxLength={2}
          pattern="[A-Za-z]{2}"
          autoComplete="country"
          defaultValue={location?.countryCode ?? ''}
        />
      </fieldset>

      <fieldset>
        <legend>Coordonnées géographiques</legend>
        <p id="coordinates-help">Utilisez des coordonnées en degrés décimaux.</p>
        <label htmlFor="latitude">Latitude</label>
        <input
          id="latitude"
          name="latitude"
          type="number"
          step="any"
          inputMode="decimal"
          min={-90}
          max={90}
          aria-describedby="coordinates-help"
          defaultValue={location?.latitude ?? ''}
        />

        <label htmlFor="longitude">Longitude</label>
        <input
          id="longitude"
          name="longitude"
          type="number"
          step="any"
          inputMode="decimal"
          min={-180}
          max={180}
          aria-describedby="coordinates-help"
          defaultValue={location?.longitude ?? ''}
        />
      </fieldset>

      <fieldset>
        <legend>Horaires de retrait et de retour</legend>
        <p id="opening-hours-help">
          Cochez les jours ouverts et renseignez au moins un créneau pour publier l’établissement.
        </p>
        {LOCATION_WEEKDAYS.map(({ value: weekday, label }) => {
          const dayHours = hoursByDay.get(weekday) ?? [];
          const slotCount = Math.max(LOCATION_HOUR_SLOTS, dayHours.length);
          return (
            <fieldset key={weekday}>
              <legend>{label}</legend>
              <label htmlFor={`openDay-${weekday}`}>
                <input
                  id={`openDay-${weekday}`}
                  name={`openDay-${weekday}`}
                  type="checkbox"
                  defaultChecked={dayHours.length > 0}
                />{' '}
                Ouvert
              </label>
              {Array.from({ length: slotCount }, (_, slot) => {
                const hour = dayHours[slot];
                return (
                  <div key={slot}>
                    <span>Créneau {slot + 1}</span>
                    <label htmlFor={`openTime-${weekday}-${slot}`}>De</label>
                    <input
                      id={`openTime-${weekday}-${slot}`}
                      name={`openTime-${weekday}-${slot}`}
                      type="time"
                      step={60}
                      aria-describedby="opening-hours-help"
                      defaultValue={toTimeInputValue(hour?.openTime)}
                    />
                    <label htmlFor={`closeTime-${weekday}-${slot}`}>À</label>
                    <input
                      id={`closeTime-${weekday}-${slot}`}
                      name={`closeTime-${weekday}-${slot}`}
                      type="time"
                      step={60}
                      aria-describedby="opening-hours-help"
                      defaultValue={toTimeInputValue(hour?.closeTime)}
                    />
                  </div>
                );
              })}
            </fieldset>
          );
        })}
      </fieldset>

      <fieldset>
        <legend>Publication</legend>
        <label htmlFor="pickupEnabled">
          <input
            id="pickupEnabled"
            name="pickupEnabled"
            type="checkbox"
            defaultChecked={location?.pickupEnabled ?? true}
          />{' '}
          Retrait en établissement activé
        </label>
        <label htmlFor="isPubliclyListed">
          <input
            id="isPubliclyListed"
            name="isPubliclyListed"
            type="checkbox"
            defaultChecked={location?.isPubliclyListed ?? false}
          />{' '}
          Publier cet établissement dans la recherche
        </label>
        <p>
          La publication est refusée côté serveur si l’adresse, les coordonnées, le retrait ou les
          horaires sont incomplets.
        </p>
      </fieldset>
    </>
  );
}
