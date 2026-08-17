import { BehaviorSubject } from 'rxjs';
import { ProjectService } from './project.service';

describe('ProjectService macro mutations', () => {
  let service: ProjectService;

  beforeEach(() => {
    service = Object.create(ProjectService.prototype);
    (service as any).currentProjectIdSubject = new BehaviorSubject<string>('project-a');
    (service as any).serverMacroMutationQueues = new Map<string, Promise<void>>();
    service.currentPackageData = { name: 'test-project' };
  });

  it('serializes macro writes and keeps one stable project id', async () => {
    let storedPackage: any = { name: 'test-project', MACROS: [] };
    spyOn(service, 'getPackageJson').and.callFake(async (projectId?: string) => {
      expect(projectId).toBe('project-a');
      return JSON.parse(JSON.stringify(storedPackage));
    });
    const save = spyOn(service, 'saveServerFile').and.callFake(async (_path, content, projectId) => {
      expect(projectId).toBe('project-a');
      storedPackage = JSON.parse(content);
    });

    await Promise.all([
      service.addMacro('FIRST=1'),
      service.addMacro('SECOND=2'),
    ]);

    expect(save).toHaveBeenCalledTimes(2);
    expect(storedPackage.MACROS).toEqual([['FIRST=1'], ['SECOND=2']]);
    expect((service as any).serverMacroMutationQueues.size).toBe(0);
  });

  it('cancels a macro write when the project changes during its read', async () => {
    let finishRead!: (pkg: any) => void;
    const read = spyOn(service, 'getPackageJson').and.returnValue(new Promise(resolve => {
      finishRead = resolve;
    }));
    const save = spyOn(service, 'saveServerFile').and.resolveTo();

    const mutation = service.removeMacro('LV_USE_STDLIB_STRING');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(read).toHaveBeenCalledOnceWith('project-a');

    service.currentProjectId = '';
    finishRead({ MACROS: [['LV_USE_STDLIB_STRING=LV_STDLIB_CLIB']] });

    await expectAsync(mutation).toBeResolved();
    expect(save).not.toHaveBeenCalled();
  });

  it('ignores a late generator macro callback when no project is open', async () => {
    service.currentProjectId = '';
    const read = spyOn(service, 'getPackageJson');
    const save = spyOn(service, 'saveServerFile').and.resolveTo();

    await service.removeMacro('LV_USE_STDLIB_STRING');

    expect(read).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});
