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

  it('isolates top-level lexical declarations between generator executions', () => {
    const source = `
      const GENERATOR_LOCAL_VALUE = 1;
      window.__generatorExecutionCount = (window.__generatorExecutionCount || 0) + GENERATOR_LOCAL_VALUE;
    `;
    const first = (service as any).wrapGeneratorSource(source);
    const second = (service as any).wrapGeneratorSource(source);
    const generatorWindow: any = {
      Blockly: {},
      Arduino: {},
      MicropPython: {},
      MPY: {},
      JavaScript: {},
    };

    expect(() => new Function('window', `${first}\n${second}`)(generatorWindow)).not.toThrow();
    expect(generatorWindow.__generatorExecutionCount).toBe(2);
  });

  it('keeps classic-script helper functions available to other libraries', () => {
    const helperName = `__cycoreGeneratorHelper_${Date.now()}`;
    const resultName = `${helperName}_result`;
    const definingScript = document.createElement('script');
    const consumingScript = document.createElement('script');
    definingScript.text = (service as any).wrapGeneratorSource(
      `function ${helperName}() { return 42; }`,
    );
    consumingScript.text = (service as any).wrapGeneratorSource(
      `window['${resultName}'] = ${helperName}();`,
    );

    try {
      document.head.appendChild(definingScript);
      document.head.appendChild(consumingScript);
      expect((window as any)[resultName]).toBe(42);
    } finally {
      definingScript.remove();
      consumingScript.remove();
      (window as any)[helperName] = undefined;
      delete (window as any)[resultName];
    }
  });

  it('rejects a server library result from an expired project generation', () => {
    (service as any).projectService = { currentProjectId: 'project-a' };
    (service as any).serverLibraryLoadGeneration = 4;

    expect((service as any).isServerLibraryLoadActive('project-a', 4)).toBeTrue();
    expect((service as any).isServerLibraryLoadActive('project-a', 3)).toBeFalse();

    (service as any).projectService.currentProjectId = 'project-b';
    expect((service as any).isServerLibraryLoadActive('project-a', 4)).toBeFalse();
  });
});
