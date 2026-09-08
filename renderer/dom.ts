type ElementConstructor<T extends Element> = { new (): T };
export function requireElement<T extends Element>(
  selector: string,
  ctor: ElementConstructor<T>,
): T {
  const element = document.querySelector(selector);
  if (!(element instanceof ctor))
    throw new Error(`Missing required element: ${selector}`);
  return element;
}
export function byId<T extends HTMLElement>(
  id: string,
  ctor: ElementConstructor<T>,
): T {
  const element = document.getElementById(id);
  if (!(element instanceof ctor))
    throw new Error(`Missing required element: #${id}`);
  return element;
}
export function closestElement(
  target: EventTarget | null,
  selector: string,
): HTMLElement | null {
  return target instanceof HTMLElement
    ? target.closest<HTMLElement>(selector)
    : null;
}
