"use strict";
class Person {
    name;
    age;
    constructor(name, age) {
        this.name = name;
        this.age = age;
    }
}
class Student extends Person {
    grade;
    constructor(name, age, grade) {
        super(name, age);
        this.grade = grade;
    }
}
const person = new Person("John", 30);
const student = new Student("Jane", 20, "A");
console.log('student', student);
