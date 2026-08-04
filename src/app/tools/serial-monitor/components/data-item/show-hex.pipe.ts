import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'showHex',
  standalone: true
})
export class ShowHexPipe implements PipeTransform {
  transform(value: Uint8Array | string): string {
    if (!value) return '';
    let bytes: Uint8Array;
    
    // 如果输入是字符串，将其转换为Uint8Array
    if (typeof value === 'string') {
      bytes = new TextEncoder().encode(value);
    } else {
      bytes = value;
    }
    
    // 使用单个文本节点显示 Hex，避免为每个字节创建一个 span。
    const hexArray = new Array<string>(bytes.length);
    for (let index = 0; index < bytes.length; index++) {
      hexArray[index] = bytes[index].toString(16).padStart(2, '0').toUpperCase();
    }
    return hexArray.join(' ');
  }
}
