import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'addNewLine',
  standalone: true
})
export class AddNewLinePipe implements PipeTransform {
  transform(value: Uint8Array | string): string {
    if (value instanceof Uint8Array) {
      return new TextDecoder().decode(value);
    }
    return value || '';
  }
}
