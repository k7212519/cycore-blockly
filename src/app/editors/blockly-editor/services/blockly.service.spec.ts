import { BlocklyService } from './blockly.service';

describe('BlocklyService generator loading', () => {
  let service: BlocklyService;

  beforeEach(() => {
    service = Object.create(BlocklyService.prototype);
  });

  it('ignores element resource errors while a generator script is loading', () => {
    const resourceError = {
      target: document.createElement('img'),
      filename: '',
    } as unknown as Event;

    expect((service as any).isRuntimeErrorFromScript(resourceError, 'blob:test-generator')).toBeFalse();
  });

  it('ignores window errors without a matching generator filename', () => {
    const missingFilename = {
      target: window,
      filename: '',
    } as unknown as Event;
    const otherScript = {
      target: window,
      filename: 'blob:other-script',
    } as unknown as Event;

    expect((service as any).isRuntimeErrorFromScript(missingFilename, 'blob:test-generator')).toBeFalse();
    expect((service as any).isRuntimeErrorFromScript(otherScript, 'blob:test-generator')).toBeFalse();
  });

  it('accepts only runtime errors emitted by the current generator script', () => {
    const generatorError = {
      target: window,
      filename: 'blob:test-generator',
      message: 'generator failed',
    } as unknown as Event;

    expect((service as any).isRuntimeErrorFromScript(generatorError, 'blob:test-generator')).toBeTrue();
  });

  it('reuses an in-flight generator load for the same library', async () => {
    (service as any).generatorLoadsInFlight = new Map<string, Promise<boolean>>();
    let finishLoad!: (success: boolean) => void;
    const load = jasmine.createSpy('load').and.returnValue(new Promise<boolean>(resolve => {
      finishLoad = resolve;
    }));

    const firstLoad = (service as any).runGeneratorLoadOnce('server:project:library', load);
    const secondLoad = (service as any).runGeneratorLoadOnce('server:project:library', load);

    expect(secondLoad).toBe(firstLoad);
    expect(load).toHaveBeenCalledTimes(1);

    finishLoad(true);
    await expectAsync(firstLoad).toBeResolvedTo(true);
    expect((service as any).generatorLoadsInFlight.size).toBe(0);
  });
});
