declare module '@mapbox/polyline' {
  interface Polyline {
    decode(str: string): [number, number][];
  }
  const polyline: Polyline;
  export default polyline;
}
