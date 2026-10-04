class Person {
  constructor(
    public name: string,
    public age: number,
  ) {}
}
class Student extends Person {
  constructor(
    name: string,
    age: number,
    public grade: string,
  ) {
    super(name, age);
  }
}

const person = new Person("John", 30);
const student = new Student("Jane", 20, "A");
console.log('student', student)