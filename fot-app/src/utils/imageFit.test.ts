import { describe, expect, it } from 'vitest';
import { fitImageSize } from './imageFit';

const box = { w: 400, h: 300 };

describe('fitImageSize', () => {
  it('вписывает широкую картинку по ширине области', () => {
    expect(fitImageSize({ w: 800, h: 400 }, box, 1, 0)).toEqual({ w: 400, h: 200 });
  });

  it('вписывает высокую картинку по высоте области', () => {
    expect(fitImageSize({ w: 400, h: 800 }, box, 1, 0)).toEqual({ w: 150, h: 300 });
  });

  it('мелкую картинку не растягивает', () => {
    expect(fitImageSize({ w: 100, h: 50 }, box, 1, 0)).toEqual({ w: 100, h: 50 });
  });

  it('при повороте на 90° вписывает по обменянным сторонам', () => {
    // Боком широкая картинка упирается в высоту области: 300 / 800.
    expect(fitImageSize({ w: 800, h: 400 }, box, 1, 90)).toEqual({ w: 300, h: 150 });
  });

  it('поворот на 180° стороны не меняет', () => {
    expect(fitImageSize({ w: 800, h: 400 }, box, 1, 180)).toEqual(fitImageSize({ w: 800, h: 400 }, box, 1, 0));
  });

  it('зум увеличивает вписанный размер', () => {
    expect(fitImageSize({ w: 800, h: 400 }, box, 2, 0)).toEqual({ w: 800, h: 400 });
  });

  it('без размеров картинки или области возвращает null', () => {
    expect(fitImageSize(null, box, 1, 0)).toBeNull();
    expect(fitImageSize({ w: 800, h: 400 }, null, 1, 0)).toBeNull();
    expect(fitImageSize({ w: 800, h: 400 }, { w: 0, h: 300 }, 1, 0)).toBeNull();
  });
});
