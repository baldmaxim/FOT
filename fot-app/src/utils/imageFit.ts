export interface IFitSize {
  w: number;
  h: number;
}

/**
 * Размер картинки, вписанной в область, с учётом поворота и зума.
 *
 * Повёрнутая на 90° картинка занимает область «боком», поэтому вписываем по
 * обменянным сторонам, а возвращаем размер неповёрнутой: поворот делает CSS.
 * Масштаб ограничен единицей — мелкий скан не растягиваем, его увеличивает
 * только зум. null, пока размеры картинки или области неизвестны.
 */
export const fitImageSize = (
  natural: IFitSize | null,
  box: IFitSize | null,
  zoom: number,
  rotation: number,
): IFitSize | null => {
  if (!natural || !box) return null;
  if (natural.w <= 0 || natural.h <= 0 || box.w <= 0 || box.h <= 0) return null;
  const sideways = Math.abs(rotation % 180) === 90;
  const scale = Math.min(
    1,
    box.w / (sideways ? natural.h : natural.w),
    box.h / (sideways ? natural.w : natural.h),
  ) * zoom;
  return { w: natural.w * scale, h: natural.h * scale };
};
